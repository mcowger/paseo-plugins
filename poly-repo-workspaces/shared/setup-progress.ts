import type { ManifestConstituent } from "./manifest";

export function setupLabel(constituent: ManifestConstituent): string {
  switch (constituent.setupStatus) {
    case "pending":
      return "pending";
    case "checking-out":
      return "checking out";
    case "checked-out":
      return "checked out";
    case "running-init":
      return "running init";
    case "ready":
      return "ready";
    case "failed":
      return "failed";
    default:
      if (constituent.state === "removed") return "removed";
      if (constituent.state === "missing") return "missing";
      if (constituent.state === "created" && constituent.initState !== "pending") return "ready";
      return constituent.state === "created" ? "checked out" : "pending";
  }
}
