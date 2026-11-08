/**
 * I-023 调度台的模块清单：haiku "知道软件有哪些模块"就是靠这一张表。
 * 新模块接上调度台：在它自己的文件里写一条 RoutedModule（我管什么、什么话算叫我、本机粗筛的字），在这里加一行。
 * 交给 haiku 的清单由 choose.ts 的 routerModuleList 从这张表自动拼出来，不用另写提示词。
 *
 * 只登记"错了没关系、回复说完才做"的事（I-023 我的意见）：开局、以后的纪念提议、昵称……
 * Opus 开口前就要定、而且涉及隐私的事（截屏、带不带听到的原文）不登记在这里。
 */
import { RPS_ROUTE } from '../rps-personality';
import type { RoutedModule } from './interface';
import { NICKNAME_HER_ROUTE, NICKNAME_USER_ROUTE } from './nickname';

export const ROUTED_MODULES: readonly RoutedModule[] = Object.freeze([
  RPS_ROUTE,
  NICKNAME_HER_ROUTE,
  NICKNAME_USER_ROUTE,
]);
