// Synthetic memories and questions for the BGE recall tests and measurements. Invented sentences only: no real chat text anywhere.

export interface CorpusMemory { id: string; text: string }
export interface CorpusQuery { query: string; expect: string; /** memories that must NOT outrank `expect` */ not?: string[] }

export const CORPUS: CorpusMemory[] = [
  { id: 'cat', text: '我养了一只橘猫叫团子' },
  { id: 'dog', text: '我邻居养了一只柴犬，每天傍晚都在楼下遛' },
  { id: 'peanut', text: '我对花生过敏，上次吃完起了一身疹子' },
  { id: 'tokyo', text: '我下个月要去东京出差一周' },
  { id: 'redbraised', text: '我妈妈周末做了红烧肉，我吃了两大碗' },
  { id: 'interview', text: '昨天面试被拒了，心里很沮丧' },
  { id: 'guitar', text: '我最近在学吉他，手指都磨疼了' },
  { id: 'band', text: '我最喜欢的乐队是五月天，高中就开始听了' },
  { id: 'cilantro', text: '我不喜欢香菜，闻到那个味道就想吐' },
  { id: 'shanghai', text: '我搬到了上海浦东，租了一间小公寓' },
  { id: 'thesis', text: '论文答辩定在六月十五日，我还没准备好' },
  { id: 'insomnia', text: '这周我连着三天失眠，凌晨四点才睡着' },
  { id: 'bike', text: '周日我骑自行车去了郊外，一路上都是油菜花' },
  { id: 'exam', text: '我报名了雅思考试，打算明年出国读书' },
  { id: 'ramen', text: '新开的那家拉面店汤头很浓，下次想再去' },
  { id: 'birthday', text: '我生日是十月三号，朋友们给我订了蛋糕' },
  { id: 'cold', text: '前天淋了雨，现在发烧咳嗽，嗓子很痛' },
  { id: 'catnot', text: '我以前养过猫，后来搬家以后就没再养了，不打算再养猫' },
  { id: 'cat2', text: '朋友家的猫生了四只小猫，我只是去看了看' },
  { id: 'dogtuanzi', text: '公司楼下便利店的柴犬也叫团子，它特别黏人' },
  { id: 'work', text: '老板让我下周交季度报告，我加班到很晚' },
  { id: 'movie', text: '昨晚看了一部很感人的电影，我哭了' },
];

export const QUERIES: CorpusQuery[] = [
  { query: '你还记得我家那只猫吗', expect: 'cat', not: ['dogtuanzi', 'catnot'] },
  { query: '我能吃坚果吗', expect: 'peanut' },
  { query: '你记得我要去日本的事吗', expect: 'tokyo' },
  { query: '最近找工作怎么样了', expect: 'interview' },
  { query: '我在练什么乐器来着', expect: 'guitar' },
  { query: '点菜的时候要避开什么', expect: 'cilantro' },
  { query: '我现在住在哪个城市', expect: 'shanghai' },
  { query: '我毕业的事怎么样了', expect: 'thesis' },
  { query: '我睡眠不太好', expect: 'insomnia' },
  { query: '我打算出国留学', expect: 'exam' },
  { query: '我身体不舒服', expect: 'cold' },
  { query: '最近工作压力好大', expect: 'work' },
];

/** Questions that have no matching memory at all (nothing should come back above the threshold). */
export const UNRELATED: string[] = ['今天天气怎么样', '帮我想一个周末的计划', '你喜欢什么颜色', '给我讲个笑话吧', '早上好'];
