// Prompts MobileCLIP compares each frame with (scripts/make-clip-text.mjs → src/core/clip-text.ts).
// W: a woman or women are in the picture · M: only men · N: no people.
// No prompts about text, logos or screens: video often has captions over people, and such prompts
// took the score away from women dancing behind a title (0.08 → 0.5–1 without them). Chosen on
// 699 labelled pictures (portraits, groups, dancers, cars, factories, buildings, mountains, frames
// of a real video): with the women score ≥ CLIP_WOMEN (0.5), 96–99% of pictures of women, 0% of
// pictures without people, 1% of portraits of men and ~10% of groups of young men.
export const CLIP_PROMPTS = {
  W: [
    'a photo of a woman',
    'a photo of women',
    'a photo of a girl',
    'a woman in a dress',
    'women dancing',
    'a female singer on stage',
    'a group of women',
    'a woman talking to the camera',
    'a man and a woman together',
    'ballerinas',
    'a woman in a swimsuit',
    'a woman walking on the street',
  ],
  M: [
    'a photo of a man',
    'a photo of men',
    'a photo of a boy',
    'a man in a suit',
    'men dancing',
    'a male singer on stage',
    'a group of men',
    'a man talking to the camera',
    'men working in a factory',
    'a man walking on the street',
  ],
  N: [
    'a photo of a car',
    'a factory',
    'a city street',
    'a building',
    'a landscape',
    'a chart or infographic',
    'an animal',
    'food',
    'an empty room',
    'a product close-up',
    'a mountain',
  ],
};
