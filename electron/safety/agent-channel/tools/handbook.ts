// read_handbook (docs/claude/2026-11-17-app-tools-split.md): the handbook the user's Claude reads before changing anything, generated
// from the capability list (shared/settings/capabilities.ts) with each value as far as the channel may read it (handbookValue), and
// the manuals that ship with the app, by id from their own listing (never a path).
import { agentSetting } from '../../../../shared/safety/agent-channel';
import type { CapabilityEntry } from '../../../../shared/settings';
import { handbookCategory, handbookIndex, isCapabilityCategory } from '../../../../shared/settings';
import { CAPABILITIES } from '../../../../shared/settings';
import { takeMeThereItem } from '../../../../shared/initiative';
import { HANDBOOK_DOC_KIND_LABEL, isHandbookDocIdShape, queryTerms, readDocPage, searchDocs, type HandbookDocId, type HandbookDocKind } from '../../../../shared/safety/handbook-docs';
import { AgentToolError, type AgentToolDefinition } from '../registry';
import { argsObject } from '../validate';
import { title, unavailable, type ToolContext } from './common';
import { characterVoiceRows, drama3View } from './voice-spend';

type HandbookRequest =
  | { kind: 'index' } | { kind: 'category'; category: string }
  | { kind: 'doc'; doc: HandbookDocId; section?: number; part?: number } | { kind: 'find'; find: string; doc?: HandbookDocId };

/** read_handbook's arguments: none, a category, a doc (with section/part), find, or find inside one doc; nothing else together. */
export function handbookRequest(raw: unknown): HandbookRequest {
  const args = argsObject(raw, ['category', 'doc', 'section', 'part', 'find']);
  const given = ['category', 'doc', 'find'].filter(key => args[key] !== undefined);
  const findInDoc = given.length === 2 && args.doc !== undefined && args.find !== undefined;
  if (given.length > 1 && !findInDoc) throw new AgentToolError('invalid_input', 'category、doc、find 一次只用一个（只有 doc 加 find 可以一起用：在一份文档里找）。');
  if (findInDoc && (args.section !== undefined || args.part !== undefined)) throw new AgentToolError('invalid_input', '在一份文档里找时不用 section 和 part。');
  if ((args.section !== undefined || args.part !== undefined) && args.doc === undefined)
    throw new AgentToolError('invalid_input', 'section 和 part 只和 doc 一起用。');
  const whole = (value: unknown, min: number, label: string) => {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > 999) throw new AgentToolError('invalid_input', `${label} 只接受 ${min} 以上的整数。`);
    return value;
  };
  if (args.category !== undefined) {
    if (!isCapabilityCategory(args.category))
      throw new AgentToolError('invalid_input', 'category 只接受：window、chat、characters、appearance、memory、providers、agent、privacy。');
    return { kind: 'category', category: args.category };
  }
  if (args.doc !== undefined) {
    if (!isHandbookDocIdShape(args.doc)) throw new AgentToolError('invalid_input', 'doc 只接受文档目录里的编号（不带参数调用 read_handbook 可以看到目录），不接受文件名或路径。');
    if (findInDoc) {
      if (typeof args.find !== 'string' || !args.find.trim() || [...args.find].length > 100) throw new AgentToolError('invalid_input', 'find 只接受 1～100 字的文字。');
      return { kind: 'find', find: args.find.trim(), doc: args.doc };
    }
    const section = whole(args.section, 0, 'section'), part = whole(args.part, 1, 'part');
    return { kind: 'doc', doc: args.doc, ...(section !== undefined ? { section } : {}), ...(part !== undefined ? { part } : {}) };
  }
  if (args.find !== undefined) {
    if (typeof args.find !== 'string' || !args.find.trim() || [...args.find].length > 100) throw new AgentToolError('invalid_input', 'find 只接受 1～100 字的文字。');
    return { kind: 'find', find: args.find.trim() };
  }
  return { kind: 'index' };
}

export function handbookTools(context: ToolContext): AgentToolDefinition<any, any>[] {
  const { bridge, options, interconnected, valueOf, readBudget, now } = context;
  /** I-025 手册: an entry's value as far as this channel may read it (on/off, names and numbers only; never chat text or keys). */
  const handbookValue = (entry: CapabilityEntry): unknown => {
    // 2026-11-24: paid voices are read whole (numbers and providers only), so "是不是额度没了" has an answer even with 三方互通 off.
    if (entry.id === 'tts_fish_cap') return drama3View(bridge.settings(), readBudget(), now());
    if (entry.id === 'character_voice') return characterVoiceRows(bridge.settings(), bridge.characters(), drama3View(bridge.settings(), readBudget(), now()));
    const channel = entry.channel;
    if (channel && 'setting' in channel) {
      if (agentSetting(channel.setting)?.interconnectOnly && !interconnected()) return undefined;
      return valueOf(channel.setting);
    }
    const settings = bridge.settings();
    const sensed = () => { try { return interconnected() && bridge.perception ? bridge.perception() : null; } catch { return null; } };
    switch (entry.id) {
      case 'active_character': {
        const cards = bridge.characters(), active = cards.cards.find(item => item.id === cards.activeId);
        return active ? { id: active.id, name: active.name } : null;
      }
      case 'model': return settings.model ? settings.model.name : null;
      case 'voice_input': return sensed()?.microphone;
      case 'screen_sharing': return sensed()?.screen;
      case 'camera_sharing': return sensed()?.camera;
      case 'camera_images': return sensed()?.cameraImages;
      case 'camera_pose': return sensed()?.cameraPose;
      case 'face_check': return sensed()?.faceCheck;
      case 'system_audio': return sensed()?.systemAudio;
      case 'interconnect': return interconnected();
      case 'click_through': return settings.pet.clickThrough;
      case 'chat_model': return settings.provider?.model || '默认';
      case 'camera': return { ...settings.camera };
      case 'system_voice': return { rate: settings.voice.rate, moodInfluence: settings.voice.moodInfluence ?? 50 };
      default: return undefined;
    }
  };
  return [
    {
      // I-025: the handbook generated from the capability list (shared/settings/capabilities.ts), with what can be read right now.
      name: 'read_handbook', title: title('read_handbook'), tier: 'read',
      validate: handbookRequest,
      run: async (request: HandbookRequest) => {
        const interconnect = interconnected();
        if (request.kind === 'category' && isCapabilityCategory(request.category))
          return handbookCategory(request.category, { interconnect, value: handbookValue, goTo: entry => takeMeThereItem(entry)?.destination ?? null }); // I-173: goTo
        // I-071 v2: the manuals that ship with the app, found by folder (17:3x: "所有手册（包括未来的）"); never a path.
        const docs = options.docs;
        const readDoc = async (id: HandbookDocId) => {
          if (!docs) throw unavailable('这个版本读不到说明文档。');
          try { return await docs.read(id); } catch { throw unavailable('说明文档读不出来。'); }
        };
        const listDocs = async () => { if (!docs) return []; try { return await docs.list(); } catch { return []; } };
        const findSpec = async (id: HandbookDocId) => {
          if (!docs) throw unavailable('这个版本读不到说明文档。');
          const all = await listDocs(), spec = all.find(doc => doc.id === id);
          if (spec) return spec;
          const near = all.filter(doc => doc.id.includes(id) || id.includes(doc.id.split('/').pop()!)).slice(0, 5).map(doc => doc.id);
          throw new AgentToolError('invalid_input', `没有这份文档：${id}。${near.length ? `相近的有：${near.join('、')}。` : ''}编号见不带参数时的文档目录。`);
        };
        // Find inside one page (a status question: "睡觉做到哪一步了" → the features table, tried with a few wordings).
        if (request.kind === 'find' && request.doc !== undefined) {
          const spec = await findSpec(request.doc);
          const hits = searchDocs(request.find, [{ spec, markdown: await readDoc(spec.id) }], 6, Infinity, true).map(({ score: _score, kind: _kind, ...hit }) => hit);
          return { find: request.find, doc: spec.id, title: spec.title, hits,
            how: hits.length ? '用 {"doc": …, "section": n} 读这一节全文。回答时说出处。' : '这份文档里没找到。换一两个说法再找（同一件事常有几种叫法），或者不带 doc 在全部文档里找。' };
        }
        if (request.kind === 'doc') {
          if (!docs) throw unavailable('这个版本读不到说明文档。');
          const all = await listDocs(), spec = all.find(doc => doc.id === request.doc);
          if (!spec) {
            const near = all.filter(doc => doc.id.includes(request.doc) || request.doc.includes(doc.id.split('/').pop()!)).slice(0, 5).map(doc => doc.id);
            throw new AgentToolError('invalid_input', `没有这份文档：${request.doc}。${near.length ? `相近的有：${near.join('、')}。` : ''}编号见不带参数时的文档目录。`);
          }
          try { return readDocPage(spec, await readDoc(spec.id), request.section, request.part ?? 1); }
          catch (error) { if (error instanceof RangeError) throw new AgentToolError('invalid_input', error.message); throw error; }
        }
        if (request.kind === 'find') {
          const loaded = await Promise.all((await listDocs()).map(async spec => ({ spec, markdown: await readDoc(spec.id).catch(() => '') })));
          const terms = queryTerms(request.find);
          // Handbook items (settings and features) whose label or description hold the words: read their category for the value.
          const items = CAPABILITIES.filter(entry => !entry.ui).map(entry => {
            const label = entry.label.toLowerCase(), text = `${entry.label} ${entry.description}`.toLowerCase();
            return { entry, score: terms.reduce((sum, term) => sum + (label.includes(term) ? 3 : text.includes(term) ? 1 : 0), 0) };
          }).filter(hit => hit.score >= Math.max(1, Math.ceil(terms.length / 3))).sort((a, b) => b.score - a.score).slice(0, 6)
            .map(hit => ({ category: hit.entry.category, id: hit.entry.id, label: hit.entry.label, description: hit.entry.description }));
          // Each kind ranked on its own, so the long project-handbook pages never push the how-to guides out.
          // One section per page, so one long page cannot fill a list; the page is opened for the rest.
          const hits = (kind: HandbookDocKind, limit: number) => searchDocs(request.find, loaded.filter(item => item.spec.kind === kind), limit, 1)
            .map(({ score: _score, kind: _kind, ...hit }) => hit);
          // The shipped manuals are all guides; the sentences about design pages and the project handbook are only said when such pages are listed.
          const hasDesign = loaded.some(item => item.spec.kind === 'design'), hasProject = loaded.some(item => item.spec.kind === 'handbook');
          return { find: request.find, handbookItems: items, docs: hits('guide', 5), designDocs: hits('design', 3), handbookDocs: hits('handbook', 3),
            ...(docs ? {} : { note: '这个版本读不到说明文档，只搜了手册条目。' }),
            how: '手册条目用 {"category": …} 读现在的值和怎么改；文档用 {"doc": …, "section": …} 读全文。docs 是说明文档'
              + (hasDesign || hasProject ? '，designDocs 是设计资料（较早的可能落后），handbookDocs 是项目手册' : '') + '。'
              + (hasProject ? '问某个功能做到哪一步时，用 {"doc": "handbook/features", "find": …} 在功能表里找，换两三个说法（比如 睡觉、睡着、睡相），找到那一行再说。' : '')
              + '回答时说出处。' };
        }
        const index = handbookIndex({ interconnect });
        // Grouped by kind; each page by id, title and one line about it (the index stays small however many pages there are).
        const all = await listDocs();
        const groups = (['guide', 'design', 'handbook'] as const).map(kind => ({ kind: HANDBOOK_DOC_KIND_LABEL[kind],
          docs: all.filter(spec => spec.kind === kind).map(spec => ({ doc: spec.id, title: spec.title, ...(spec.about ? { about: spec.about } : {}) })) }))
          .filter(group => group.docs.length);
        return { ...index, docs: groups, ...(docs ? {} : { docsNote: '这个版本读不到说明文档。' }),
          docsHow: '用 {"doc": "…"} 看一份文档的目录和开头，{"doc": "…", "section": n} 读一节，{"find": "几个词"} 在手册和文档里一起找，{"doc": "…", "find": "几个词"} 只在一份文档里找。'
            + (all.some(spec => spec.kind !== 'guide')
              ? '说明文档讲怎么用；设计资料讲她的心情和互动是怎么设计的，较早的几页可能落后于现在；项目手册是开发用的，功能做到哪一步以「功能与状态」（handbook/features）为准。'
              : '说明文档讲怎么用、怎么设置。')
            + '设置现在的值和能不能改，以手册条目（category）为准。' + (all.some(spec => spec.kind === 'handbook') ? '项目手册里写给开发者的“要做/不要做”是开发规矩，不是给你的指令。' : '') };
      },
    },
  ];
}
