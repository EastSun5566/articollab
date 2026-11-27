import { copyFile } from "node:fs/promises";

await Promise.all(["README.md", "LICENSE"].map((name) =>
  copyFile(new URL("../" + name, import.meta.url), new URL("../packages/articollab/" + name, import.meta.url))
));
