/// ALTO XML parser for Harvard CAP digitized page scans.
///
/// Parses gzipped ALTO v3 XML into structured page data with
/// word-level bounding boxes for text overlay rendering.

use anyhow::{Context, Result};
use flate2::read::GzDecoder;
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use std::io::Read;

#[derive(Debug, Serialize, Deserialize)]
pub struct AltoPage {
    pub width: u32,
    pub height: u32,
    pub lines: Vec<AltoLine>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AltoLine {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub words: Vec<AltoWord>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AltoWord {
    pub text: String,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub confidence: f32,
}

/// Parse a gzipped ALTO XML file into structured page data.
pub fn parse_alto_gz(data: &[u8]) -> Result<AltoPage> {
    let mut decoder = GzDecoder::new(data);
    let mut xml_str = String::new();
    decoder
        .read_to_string(&mut xml_str)
        .context("failed to decompress ALTO gzip")?;
    parse_alto_xml(&xml_str)
}

/// Parse ALTO XML string into structured page data.
pub fn parse_alto_xml(xml: &str) -> Result<AltoPage> {
    let mut reader = Reader::from_str(xml);

    let mut page_width: u32 = 0;
    let mut page_height: u32 = 0;
    let mut lines: Vec<AltoLine> = Vec::new();
    let mut current_line: Option<AltoLine> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                let name = e.local_name();
                match name.as_ref() {
                    b"Page" => {
                        for attr in e.attributes().flatten() {
                            match attr.key.local_name().as_ref() {
                                b"WIDTH" => {
                                    page_width = parse_attr_u32(&attr.value);
                                }
                                b"HEIGHT" => {
                                    page_height = parse_attr_u32(&attr.value);
                                }
                                _ => {}
                            }
                        }
                    }
                    b"TextLine" => {
                        let mut x = 0;
                        let mut y = 0;
                        let mut w = 0;
                        let mut h = 0;
                        for attr in e.attributes().flatten() {
                            match attr.key.local_name().as_ref() {
                                b"HPOS" => x = parse_attr_u32(&attr.value),
                                b"VPOS" => y = parse_attr_u32(&attr.value),
                                b"WIDTH" => w = parse_attr_u32(&attr.value),
                                b"HEIGHT" => h = parse_attr_u32(&attr.value),
                                _ => {}
                            }
                        }
                        current_line = Some(AltoLine {
                            x,
                            y,
                            width: w,
                            height: h,
                            words: Vec::new(),
                        });
                    }
                    b"String" => {
                        let mut text = String::new();
                        let mut x = 0;
                        let mut y = 0;
                        let mut w = 0;
                        let mut h = 0;
                        let mut wc: f32 = 0.0;
                        for attr in e.attributes().flatten() {
                            match attr.key.local_name().as_ref() {
                                b"CONTENT" => {
                                    text = String::from_utf8_lossy(&attr.value).to_string();
                                }
                                b"HPOS" => x = parse_attr_u32(&attr.value),
                                b"VPOS" => y = parse_attr_u32(&attr.value),
                                b"WIDTH" => w = parse_attr_u32(&attr.value),
                                b"HEIGHT" => h = parse_attr_u32(&attr.value),
                                b"WC" => {
                                    wc = std::str::from_utf8(&attr.value)
                                        .unwrap_or("0")
                                        .parse()
                                        .unwrap_or(0.0);
                                }
                                _ => {}
                            }
                        }
                        if let Some(ref mut line) = current_line {
                            line.words.push(AltoWord {
                                text,
                                x,
                                y,
                                width: w,
                                height: h,
                                confidence: wc,
                            });
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::End(ref e)) => {
                if e.local_name().as_ref() == b"TextLine" {
                    if let Some(line) = current_line.take() {
                        if !line.words.is_empty() {
                            lines.push(line);
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(anyhow::anyhow!("ALTO XML parse error: {}", e)),
            _ => {}
        }
    }

    Ok(AltoPage {
        width: page_width,
        height: page_height,
        lines,
    })
}

fn parse_attr_u32(value: &[u8]) -> u32 {
    let s = std::str::from_utf8(value).unwrap_or("0");
    // Handle float values like "1618.0" by parsing as f32 first
    s.parse::<f32>().unwrap_or(0.0) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_gzipped_alto_from_fixture() {
        let data = std::fs::read("tests/fixtures/alto-sample.xml.gz")
            .expect("test fixture alto-sample.xml.gz missing");

        let page = parse_alto_gz(&data).expect("should parse ALTO");

        assert_eq!(page.width, 1888);
        assert_eq!(page.height, 3000);
        assert!(!page.lines.is_empty(), "should have text lines");

        // First text block should contain the page number "647"
        let all_words: Vec<&str> = page
            .lines
            .iter()
            .flat_map(|l| l.words.iter())
            .map(|w| w.text.as_str())
            .collect();
        assert!(
            all_words.contains(&"647"),
            "page should contain reporter page number 647"
        );
    }

    #[test]
    fn words_have_bounding_boxes() {
        let data = std::fs::read("tests/fixtures/alto-sample.xml.gz")
            .expect("test fixture missing");

        let page = parse_alto_gz(&data).unwrap();
        let first_word = &page.lines[0].words[0];

        assert!(first_word.width > 0, "word should have width");
        assert!(first_word.height > 0, "word should have height");
        assert!(!first_word.text.is_empty(), "word should have text");
    }

    #[test]
    fn lines_have_positions() {
        let data = std::fs::read("tests/fixtures/alto-sample.xml.gz")
            .expect("test fixture missing");

        let page = parse_alto_gz(&data).unwrap();

        for line in &page.lines {
            assert!(line.width > 0);
            assert!(line.height > 0);
            assert!(!line.words.is_empty());
        }
    }

    #[test]
    fn parse_plain_alto_xml() {
        let xml = r#"<?xml version='1.0' encoding='utf-8'?>
        <alto xmlns="http://www.loc.gov/standards/alto/ns-v3#">
          <Layout>
            <Page HEIGHT="3000" WIDTH="1888">
              <PrintSpace>
                <TextBlock>
                  <TextLine HEIGHT="41" HPOS="264" VPOS="283" WIDTH="746">
                    <String CONTENT="Hello" HPOS="264" VPOS="300" WIDTH="100" HEIGHT="30" WC="0.95"/>
                    <String CONTENT="World" HPOS="380" VPOS="300" WIDTH="110" HEIGHT="30" WC="0.88"/>
                  </TextLine>
                </TextBlock>
              </PrintSpace>
            </Page>
          </Layout>
        </alto>"#;

        let page = parse_alto_xml(xml).unwrap();
        assert_eq!(page.width, 1888);
        assert_eq!(page.height, 3000);
        assert_eq!(page.lines.len(), 1);
        assert_eq!(page.lines[0].words.len(), 2);
        assert_eq!(page.lines[0].words[0].text, "Hello");
        assert_eq!(page.lines[0].words[1].text, "World");
        assert_eq!(page.lines[0].words[0].x, 264);
        assert!((page.lines[0].words[0].confidence - 0.95).abs() < 0.01);
    }
}
