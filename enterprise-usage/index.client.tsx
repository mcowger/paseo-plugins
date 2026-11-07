import type { PluginClientContext } from "@getpaseo/plugin/client";
import { UsageSidebar } from "./client/usage";

export default function contribute(client: PluginClientContext) {
  return client.addSidebarFooterItem({
    id: "enterprise-usage",
    title: "Enterprise usage",
    Component: UsageSidebar,
  });
}
