import type zh from "./locales/zh-CN.json";
import { t as kitT, tParts as kitParts, type Params } from "./i18n";
type Messages = Omit<typeof zh, "$meta">;
export type MessageId = { [S in keyof Messages]: `${S & string}.${keyof Messages[S] & string}` }[keyof Messages];
export const t = (id: MessageId, params?: Params) => kitT(id, params);
export const tParts = (id: MessageId, params?: Params) => kitParts(id, params);
