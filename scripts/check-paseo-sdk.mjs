import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(await readFile(path.join(root, ".paseo-sdk.json"), "utf8"));
const sdkPackages = config.directPackages;
const errors = [];

for (const plugin of config.plugins) {
  const pluginRoot = path.join(root, plugin);
  const packageJsonPath = path.join(pluginRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
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
  console.log(`All plugins pin the Paseo SDK to ${config.version}.`);
}
