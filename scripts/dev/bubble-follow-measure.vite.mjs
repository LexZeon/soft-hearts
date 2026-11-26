// I-165 measurement only (scripts/dev/bubble-follow-measure.mjs): the app's own Vite config, with the bubble-follow knob read as 'char' (or 'off' with SOFT_HEARTS_MEASURE_BUBBLE_MODE=off, the behaviour before I-165)
// for this build. Nothing in the source changes; the default build ('sentence') uses vite.config.ts as it is.
import base from '../../vite.config.ts';

const KNOB = /mode:\s*(['"])sentence\1/;

export default {
  ...base,
  plugins: [...(base.plugins ?? []), {
    name: 'soft-hearts-bubble-follow-char',
    enforce: 'pre', // before the TypeScript transform (which may rewrite the quotes)
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith('shared/voice/bubble-follow/knobs.ts')) return null;
      if (!KNOB.test(code)) throw new Error('bubble-follow knob not found');
      const mode = process.env.SOFT_HEARTS_MEASURE_BUBBLE_MODE === 'off' ? 'off' : 'char';
      return code.replace(KNOB, `mode: '${mode}'`);
    },
  }],
};
