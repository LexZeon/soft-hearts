/**
 * I-023 调度台上的"外号"模块（docs/claude/2026-11-07-nicknames.md）：haiku 看用户这一条消息，判断是不是在
 * 给她起外号 / 用一个专属称呼叫她（nickname-her），或者在说希望她怎么称呼自己（nickname-user）。
 * 名字由 haiku 在回答里带来（name），宿主用 cleanNickname 校验后才记（electron/relationship/nickname-route.ts）。
 * 记错没关系的地方（她的外号）可以多认；用户自己的称呼只认"叫我……"这种明说，因为那是用户自己的话 = 同意。
 */
import type { RoutedModule } from './interface';

/** 粗筛：只有这些说法出现才问 haiku（随口叫外号而没有这类说法的消息，这一版漏掉，不为它多花额度）。 */
const NICKNAME_HINTS = /叫我|喊我|称呼我|管我叫|叫你|喊你|称呼你|管你叫|外号|昵称|小名|绰号|爱称|起个名|取个名|起名|取名|给你起|给你取|就叫|以后叫|以后喊|你就是我的|call me|call you|nickname/iu;

export const NICKNAME_HER_ROUTE: RoutedModule = Object.freeze<RoutedModule>({
  id: 'nickname-her',
  name: '她的外号',
  handles: '记住用户给她起的外号（或用户一直用的专属叫法），以后每次聊天她都知道这是用户对她的称呼，不再像第一次听到。',
  calledWhen: '用户这条消息是在给她起外号，或明说以后就这样叫她，或明显在用一个亲昵的专属称呼叫她，比如"以后叫你小饭团好不好""我给你起了个外号叫阿豆""你就是我的团子"。name 写那个外号本身。',
  notCalled: '用户说希望她怎么称呼用户自己（那是"nickname-user"）、讲别人的外号、问她叫什么、只是叫她原本的名字、玩笑里临时的一次叫法、引用别处的话。',
  hints: NICKNAME_HINTS,
  carriesName: true,
});

export const NICKNAME_USER_ROUTE: RoutedModule = Object.freeze<RoutedModule>({
  id: 'nickname-user',
  name: '用户的称呼',
  handles: '记住用户希望她怎么称呼用户（用户明说的，就是同意）。',
  calledWhen: '用户这条消息明确要求她以后用某个叫法称呼用户自己，比如"叫我阿蓝就好""以后喊我小蓝""你可以叫我老板"。name 写那个叫法本身。',
  notCalled: '用户给她起外号（那是"nickname-her"）、讲别人怎么叫用户、问她怎么称呼用户、玩笑里临时的一次、只是自我介绍而没有要她这样叫、要她别用某个称呼。',
  hints: NICKNAME_HINTS,
  carriesName: true,
});
