import fs from "node:fs/promises";
import path from "node:path";
import fse from "fs-extra";
import MarkdownIt from "markdown-it";

const inputFile = "docs/user-guide.md";
const docsDir = "docs";
const outDir = "dist/docs";
const outFile = path.join(outDir, "user-guide.html");

await fse.ensureDir(outDir);

const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true
});

const source = await fs.readFile(inputFile, "utf8");
const body = md.render(source);

const html = `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <title>User Guide</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="./docs.css">
</head>
<body>
  <main class="doc">
${body}
  </main>
</body>
</html>`;

await fs.writeFile(outFile, html, "utf8");

// Bilder/Assets kopieren, z.B. docs/images/*
await fse.copy(path.join(docsDir, "images"), path.join(outDir, "images"), {
    overwrite: true,
    errorOnExist: false
});

// optionales CSS
await fs.writeFile(
    path.join(outDir, "docs.css"),
    `
body {
  font-family: system-ui, sans-serif;
  line-height: 1.6;
  margin: 0;
  padding: 2rem;
}
.doc {
  max-width: 900px;
  margin: auto;
}
img {
  max-width: 100%;
}
code {
  background: #f4f4f4;
  padding: 0.1em 0.3em;
}
pre {
  background: #f4f4f4;
  padding: 1rem;
  overflow-x: auto;
}
`,
    "utf8"
);

console.log(`Generated ${outFile}`);