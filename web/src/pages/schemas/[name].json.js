// The repo's JSON Schemas (schemas/), published at the URLs their $id names,
// https://stare.pub/schemas/<file> (#161). reporters.json names its schema as
// $schema, and openapi.json refers to all three. Copied as they are at build time.
const files = import.meta.glob('../../../../schemas/*.schema.json', {
  query: '?raw',
  import: 'default',
  eager: true,
});

export function getStaticPaths() {
  return Object.entries(files).map(([path, body]) => {
    const file = path.split('/').pop();
    const { $id } = JSON.parse(body);
    if ($id !== `https://stare.pub/schemas/${file}`) {
      throw new Error(`schemas/${file}: $id is ${$id}, not its published URL`);
    }
    return { params: { name: file.replace(/\.json$/, '') }, props: { body } };
  });
}

// A static file: Workers static assets serve it as application/json by its
// extension, whatever a Response header here says.
export function GET({ props }) {
  return new Response(props.body);
}
