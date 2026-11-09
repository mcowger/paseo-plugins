import { bindTranslator, createTranslator } from "../shared/i18n";
import zh from "../shared/locales/zh-CN.json";
import kitZh from "../shared/locales/kit/zh-CN.json";
bindTranslator(createTranslator("zh-CN", [zh, kitZh]));
