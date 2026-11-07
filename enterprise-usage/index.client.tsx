import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { View } from "react-native";
import { ClaudeUsageSidebar, CodexUsageSidebar } from "./client/usage";

function EnterpriseUsageSidebar(props: PluginSidebarItemProps) {
  return <View style={{ flexDirection: "row" }}>
    <View style={{ flex: 1, minWidth: 0 }}><ClaudeUsageSidebar {...props} /></View>
    <View style={{ flex: 1, minWidth: 0 }}><CodexUsageSidebar {...props} /></View>
  </View>;
}

export default function contribute(client: PluginClientContext) {
  return client.addSidebarFooterItem({ id: "enterprise-usage", title: "Enterprise usage", Component: EnterpriseUsageSidebar });
}
