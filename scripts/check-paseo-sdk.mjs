import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(await readFile(path.join(root, ".paseo-sdk.json"), "utf8"));
const sdkPackages = config.directPackages;
const errors = [];
const skipped = [];

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

for (const plugin of config.plugins) {
  const pluginRoot = path.join(root, plugin);
  const packageJson = await readJsonIfPresent(path.join(pluginRoot, "package.json"));
  if (packageJson === undefined) {
    skipped.push(plugin);
    continue;
  }
  for (const sdkPackage of sdkPackages) {
    const locations = ["dependencies", "devDependencies", "optionalDependencies"];
    const specs = locations
      .map((location) => packageJson[location]?.[sdkPackage])
      .filter((spec) => spec !== undefined);
    if (specs.length !== 1 || specs[0] !== config.version) {
      errors.push(
        `${plugin}/package.json must pin ${sdkPackage} to ${config.version} (found ${specs.join(", ") || "missing"})`,
      );
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  const suffix = skipped.length > 0 ? ` (skipped ${skipped.length} plugin(s) not present in this checkout: ${skipped.join(", ")})` : "";
  console.log(`All present plugins pin the Paseo SDK to ${config.version}${suffix}.`);
}
