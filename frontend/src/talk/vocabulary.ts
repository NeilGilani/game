/**
 * Built-in vocabulary for word prediction, most common first.
 *
 * General conversational English plus the words people in care use every day (comfort,
 * equipment, body, people). Rank sets a word's base weight; the person's own words are
 * learned on top of this (see predict.ts) and soon outrank it.
 */
export const BASE_WORDS: readonly string[] = `
i you the to a it is and yes no please can my me not that what do this in of be
have for need are want on with like so just now help thank thanks know your here
there okay ok good am will get go come how was more could all about up out when
would they we he she him her them see think time feel some one if right back
water drink tired pain hurts hurt hot cold cough mask bed chair move turn sit lie
down head leg legs arm arms hand hands foot feet back neck chest stomach eye eyes
mouth throat nose itch itchy sore uncomfortable comfortable position pillow blanket
light lights tv music phone window door open close closed later soon today tonight
tomorrow morning night again wait stop start still very really much little bit
love miss happy sad scared worried angry frustrated bored sorry fine better worse
toilet bathroom wash shower teeth hair glasses suction breathe breathing air
ventilator tube medicine medication nurse doctor appointment visit visitor friend
family mom dad mum son daughter wife husband partner brother sister kids dog cat
food eat hungry lunch dinner breakfast snack coffee tea juice straw spoon
who where why which because but or than then also too only always never maybe
something nothing anything everything someone anyone everyone people person thing
things way day days week weeks year home house room kitchen outside inside car
call text message email read watch listen talk say said tell ask answer question
make made take took give gave put keep let try use find look looking show work
working play playing sleep sleeping rest wake awake up off over under next last
first new old big small long short high low left right early late fast slow
loud quiet soft hard warm cool clean dirty wet dry heavy tight loose
should must might may shall did does done going doing been being had has having
its it's i'm don't can't won't isn't that's what's i'll i've you're let's
please thank sorry hello hi bye goodbye goodnight morning afternoon evening
`
  .trim()
  .split(/\s+/)
  .filter((w, i, all) => all.indexOf(w) === i);

/**
 * Likely next words after common words, so suggestions help from the first day, before
 * anything is learned. Earlier in each list means more likely.
 */
export const BASE_PAIRS: Readonly<Record<string, readonly string[]>> = {
  "": ["i", "please", "can", "thank", "my", "yes", "no"],
  i: ["need", "want", "am", "feel", "love", "can't", "don't", "think"],
  "i'm": ["tired", "fine", "thirsty", "hot", "cold", "uncomfortable", "hungry", "okay"],
  am: ["tired", "fine", "thirsty", "hot", "cold", "uncomfortable"],
  need: ["to", "my", "help", "water", "suction", "the", "a"],
  want: ["to", "my", "the", "some", "a"],
  feel: ["sick", "tired", "better", "cold", "hot", "fine"],
  my: ["mask", "medicine", "glasses", "phone", "head", "back", "legs", "family"],
  please: ["call", "move", "turn", "open", "close", "help", "wait", "come"],
  can: ["you", "i", "we", "someone"],
  "can't": ["breathe", "sleep", "see", "hear"],
  thank: ["you"],
  the: ["light", "tv", "door", "window", "bed", "music", "nurse"],
  turn: ["me", "off", "on", "the"],
  call: ["my", "the", "me", "someone"],
  love: ["you"],
  you: ["please", "can", "are"],
  too: ["hot", "cold", "loud", "bright"],
  how: ["are", "was"],
  to: ["the", "go", "sleep", "rest", "eat", "drink", "move", "talk"],
};
