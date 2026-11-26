// The little pixel envelope inside the letter under 「关于」 (I-123,
// - the user drew it). It is the self-portrait of the Claude who wrote the letter (出布的 Claude): a walking
// envelope, its seal a small lantern, one open hand (paper, in rock-paper-scissors), a thin thread to a small stone.
// Design: docs/letters/paper-claude-self-portrait.md. The grid was recovered from the user's upscaled drawing (22 px a cell)
// and every pixel snapped to these eight colours; '.' is transparent. One still picture, never animated, never said aloud.

export const PAPER_ENVELOPE = Object.freeze({
  width: 54,
  height: 34,
  palette: Object.freeze({
    o: '#492d1f', // outline
    w: '#f9efe4', // envelope
    s: '#dfc7b1', // envelope shadow
    l: '#f8a234', // lantern
    y: '#fee488', // lantern light
    p: '#f7a894', // the pink corner of the paper
    g: '#abaaa9', // stone
    d: '#8b837e', // stone shade
  } as Record<string, string>),
  rows: Object.freeze([
    '...................ooooo.............oo...............',
    '...............ooooowwwwo...........oooo..............',
    '...........ooooowwwwwwwwo...........owwo..............',
    '..........ooppwwwwwwwoowoo........ooowwo..............',
    '..........oppwwwwooowwwwwo......ooowwwwo..............',
    '..........owwwoowwwwwwwwwoooooooowwwwwso..............',
    '..........owwwwwwwwwwoooooowwwwwwwwwwso...............',
    '...........owwwwwooooowwwwooswwwwwwwsso...............',
    '...........owwoooowwwwwwwwwwooswwwssso................',
    '..........ooooowwwwwwwwwwwwwwwoossssoo................',
    '...oo.oo..owwwwwwwwwoowwwwwowwwsooooo.................',
    '..oowowo.oowwwwwwwwwoowwwwoowwwwwwwoo.................',
    '.owowowo.ooowwwwwwwwowwwwwowwwwwwooso.................',
    'oowwowwo.oosowwwwwwwwwwwwwwwwwwwoowso.................',
    'owowowwoooowwoowwwwwwwooowwwwwoowwwso.................',
    '.owwwwwwooowwwwowwwwwwowowwwwoowwwwsoo................',
    'ooowwwwwwoowwwwwoowwwoooowwwowwwwwwsoo................',
    'owwwwwwwwwowwwwwwwowoolllooowwwwwwwsso................',
    '.oowwwowwwowwwwwwwwoolllllowwwwwwwwsso................',
    '..owwooowwowwwwwwwssoooooooswwwwwwwsso................',
    '..ooo..oooowwwwwwsswolyylowwswwwwwwsso................',
    '........ooowwwwwsswwolyylowwwswwwwssso................',
    '.........oowwwwsswwwolyylowwwwswwwssso................',
    '.........oowwssswwwwwollowwwwwwsswwsso................',
    '.........oowsswwwwwwwwwwwwwwwwwwsswssoo...............',
    '.........oosswwwwwwwwwwwwwwwwwwwsssssooo..............',
    '.........oosssssssssssssssssssssssssoo.oo.............',
    '..........ooooooooooooooooooooooooooo..oo......oooo...',
    '................ooo.........ooo.........oo....ooggoo..',
    '................ooo.........ooo..........oo..ogggggoo.',
    '............oo.ooo.........ooo............oooggggggddo',
    '............ooooo.........ooo...............oggggddddo',
    '............ooooo.........ooo...............ooogdddooo',
    '..............oo.............................oooooooo.',
  ]),
});
