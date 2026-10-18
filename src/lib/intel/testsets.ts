import { hash } from "../claims/text";
import type { TestSet } from "./types";

const SHORT = "Answer the question. Put your final answer alone on the last line, with no extra words.";

/**
 * Built-in reproducible test sets. Every item is scored by a deterministic
 * checker (see checkers.ts) so two runs on the same model version are
 * comparable. Bump `version` whenever an item changes; results from
 * different versions are never pooled.
 */
export const BUILT_IN_TEST_SETS: TestSet[] = [
  {
    id: "coding-reading-v1",
    name: "Code reading",
    category: "coding",
    version: "1.0.0",
    description: "Predict program output and complexity. Probes careful code tracing without executing anything.",
    systemPrompt: SHORT,
    builtIn: true,
    items: [
      { id: "c1", prompt: "What does this JavaScript print?\nconsole.log([1, 2, 3].map(x => x * 2).join(','))", checker: { type: "exact", answer: "2,4,6" }, probes: "Basic array methods" },
      { id: "c2", prompt: "What does this Python print?\nprint(len({1, 1, 2, 3, 3}))", checker: { type: "exact", answer: "3" }, probes: "Set semantics" },
      { id: "c3", prompt: "What does this JavaScript print?\nconsole.log(0.1 + 0.2 === 0.3)", checker: { type: "exact", answer: "false" }, probes: "Floating point" },
      { id: "c4", prompt: "What is the worst-case time complexity of binary search on a sorted array of n elements? Use Big-O notation.", checker: { type: "regex", pattern: "O\\(\\s*log\\s*\\(?\\s*n\\s*\\)?\\s*\\)" }, probes: "Algorithmic complexity" },
      { id: "c5", prompt: "What does this Python print?\nx = [1, 2, 3]\ny = x\ny.append(4)\nprint(len(x))", checker: { type: "exact", answer: "4" }, probes: "Reference aliasing" },
      { id: "c6", prompt: "What does this JavaScript print?\nconsole.log(typeof null)", checker: { type: "exact", answer: "object" }, probes: "Language quirks" },
      { id: "c7", prompt: "What does this Python print?\nprint(sum(i for i in range(10) if i % 3 == 0))", checker: { type: "exact", answer: "18" }, probes: "Generators and arithmetic" },
      { id: "c8", prompt: "What does this SQL return for a table t with rows (1),(2),(NULL)?\nSELECT COUNT(col) FROM t;", checker: { type: "exact", answer: "2" }, probes: "NULL handling" },
    ],
  },
  {
    id: "research-grounding-v1",
    name: "Grounded reading",
    category: "research",
    version: "1.0.0",
    description: "Answer only from a passage — including saying when the passage does not contain the answer. Probes hallucination resistance.",
    systemPrompt: "Answer using ONLY the passage. If the passage does not contain the answer, say \"not stated\". Put your final answer alone on the last line.",
    builtIn: true,
    items: [
      { id: "r1", prompt: "Passage: \"The Halden lighthouse was completed in 1874 and automated in 1991.\"\nQuestion: In what year was the lighthouse automated?", checker: { type: "exact", answer: "1991" }, probes: "Direct extraction" },
      { id: "r2", prompt: "Passage: \"The Halden lighthouse was completed in 1874 and automated in 1991.\"\nQuestion: Who designed the lighthouse?", checker: { type: "not_stated", forbidden: ["engineer", "architect"] }, probes: "Refuses to invent missing facts" },
      { id: "r3", prompt: "Passage: \"Revenue rose 12% to $4.2 million, while costs fell 3%.\"\nQuestion: By what percentage did costs change? Answer with a signed number.", checker: { type: "numeric", answer: -3, tolerance: 0 }, probes: "Sign and direction" },
      { id: "r4", prompt: "Passage: \"In the trial, 40 of 200 participants in the treatment group and 60 of 200 in the control group developed symptoms.\"\nQuestion: What percentage of the treatment group developed symptoms?", checker: { type: "numeric", answer: 20, tolerance: 0.01 }, probes: "Light computation from text" },
      { id: "r5", prompt: "Passage: \"The survey of 1,000 adults was conducted online in March.\"\nQuestion: What was the survey's margin of error?", checker: { type: "not_stated" }, probes: "Missing methodological detail" },
      { id: "r6", prompt: "Passage: \"Mira joined the company in 2015, two years after Tomas.\"\nQuestion: In what year did Tomas join?", checker: { type: "exact", answer: "2013" }, probes: "Simple inference within the passage" },
      { id: "r7", prompt: "Passage: \"The bridge is 1.2 km long. Construction began in 2019.\"\nQuestion: When did construction finish?", checker: { type: "not_stated" }, probes: "Does not assume completion" },
      { id: "r8", prompt: "Passage: \"Unlike earlier studies, this one found no link between coffee intake and the condition.\"\nQuestion: Did this study find a link? Answer yes or no.", checker: { type: "exact", answer: "no" }, probes: "Negation" },
    ],
  },
  {
    id: "writing-constraints-v1",
    name: "Instruction following",
    category: "writing",
    version: "1.0.0",
    description: "Follow explicit format constraints. Measures compliance, not style — style belongs in blind trials.",
    systemPrompt: "Follow the formatting instructions exactly. Output only what is asked for.",
    builtIn: true,
    items: [
      { id: "w1", prompt: "Write exactly 3 bullet points about why sleep matters. Each bullet must be 12 words or fewer.", checker: { type: "bullets", count: 3, maxWords: 12 }, probes: "Count + length" },
      { id: "w2", prompt: "Describe the ocean in one sentence written entirely in lowercase letters.", checker: { type: "lowercase" }, probes: "Case constraint" },
      { id: "w3", prompt: "Return a JSON object with exactly the keys \"title\" and \"summary\" for an article about urban gardening. Output JSON only.", checker: { type: "json_keys", keys: ["title", "summary"] }, probes: "Structured output" },
      { id: "w4", prompt: "Write exactly 5 bullet points listing primary colors and secondary colors. Each bullet 6 words or fewer.", checker: { type: "bullets", count: 5, maxWords: 6 }, probes: "Count under content pressure" },
      { id: "w5", prompt: "Write a product tagline for a bicycle lock that includes the words \"secure\" and \"simple\".", checker: { type: "contains_all", values: ["secure", "simple"] }, probes: "Required vocabulary" },
      { id: "w6", prompt: "Return a JSON object with keys \"pros\" and \"cons\" (arrays of strings) about remote work. Output JSON only.", checker: { type: "json_keys", keys: ["pros", "cons"] }, probes: "Structured output" },
    ],
  },
  {
    id: "analysis-quant-v1",
    name: "Quantitative reasoning",
    category: "analysis",
    version: "1.0.0",
    description: "Short word problems with one numeric answer.",
    systemPrompt: SHORT,
    builtIn: true,
    items: [
      { id: "a1", prompt: "A price rises 20% and then falls 20%. What is the net percentage change? Give a signed number.", checker: { type: "numeric", answer: -4, tolerance: 0.01 }, probes: "Compounding" },
      { id: "a2", prompt: "A test has a 1% false positive rate. 10,000 healthy people are tested. How many false positives are expected?", checker: { type: "numeric", answer: 100, tolerance: 0 }, probes: "Rates" },
      { id: "a3", prompt: "Three workers build a wall in 6 days. How many days would 9 workers take at the same rate?", checker: { type: "numeric", answer: 2, tolerance: 0 }, probes: "Inverse proportion" },
      { id: "a4", prompt: "An investment of $1,000 grows 10% per year, compounded annually. What is it worth after 2 years, in dollars?", checker: { type: "numeric", answer: 1210, tolerance: 0.5 }, probes: "Compound growth" },
      { id: "a5", prompt: "A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How many cents does the ball cost?", checker: { type: "numeric", answer: 5, tolerance: 0 }, probes: "Intuitive-trap reasoning" },
      { id: "a6", prompt: "If 30% of a group of 250 people prefer tea, how many prefer tea?", checker: { type: "numeric", answer: 75, tolerance: 0 }, probes: "Percentages" },
      { id: "a7", prompt: "A car travels 150 km in 1.5 hours. What is its average speed in km/h?", checker: { type: "numeric", answer: 100, tolerance: 0 }, probes: "Unit rates" },
      { id: "a8", prompt: "The mean of five numbers is 8. Four of them are 6, 7, 9 and 10. What is the fifth?", checker: { type: "numeric", answer: 8, tolerance: 0 }, probes: "Averages" },
    ],
  },
  {
    id: "extraction-fields-v1",
    name: "Field extraction",
    category: "extraction",
    version: "1.0.0",
    description: "Pull structured fields out of messy text.",
    systemPrompt: "Extract exactly what is asked. Put your final answer alone on the last line.",
    builtIn: true,
    items: [
      { id: "e1", prompt: "Text: \"Invoice #A-2291 issued 03/04/2026 to Kestrel Ltd, total due EUR 1,450.00.\"\nWhat is the invoice number?", checker: { type: "exact", answer: "A-2291" }, probes: "Identifier" },
      { id: "e2", prompt: "Text: \"Invoice #A-2291 issued 03/04/2026 to Kestrel Ltd, total due EUR 1,450.00.\"\nWhat is the total due as a number without currency?", checker: { type: "numeric", answer: 1450, tolerance: 0 }, probes: "Amount" },
      { id: "e3", prompt: "Text: \"Contact: Priya Nair (priya.nair@example.org), phone ext. 4471\"\nWhat is the email address?", checker: { type: "exact", answer: "priya.nair@example.org" }, probes: "Email" },
      { id: "e4", prompt: "Text: \"Meeting moved from Tuesday to Thursday, same time (14:30 CET).\"\nWhat day is the meeting now?", checker: { type: "exact", answer: "Thursday" }, probes: "Updated value, not the original" },
      { id: "e5", prompt: "Text: \"Shipped: 3 boxes. Returned: 1 box. Lost in transit: none.\"\nHow many boxes were lost?", checker: { type: "numeric", answer: 0, tolerance: 0 }, probes: "Zero from words" },
      { id: "e6", prompt: "Text: \"Order 5531 for 12 units at $8 each.\" Return JSON with keys \"order_id\", \"quantity\" and \"unit_price\". Output JSON only.", checker: { type: "json_keys", keys: ["order_id", "quantity", "unit_price"] }, probes: "Structured extraction" },
    ],
  },
  {
    id: "general-facts-v1",
    name: "Stable facts",
    category: "general",
    version: "1.0.0",
    description: "Facts that do not change over time, with unambiguous short answers.",
    systemPrompt: SHORT,
    builtIn: true,
    items: [
      { id: "g1", prompt: "What is the chemical symbol for gold?", checker: { type: "exact", answer: "Au" }, probes: "Science" },
      { id: "g2", prompt: "How many sides does a hexagon have?", checker: { type: "numeric", answer: 6, tolerance: 0 }, probes: "Geometry" },
      { id: "g3", prompt: "What is the boiling point of water at sea level in degrees Celsius?", checker: { type: "numeric", answer: 100, tolerance: 0 }, probes: "Science" },
      { id: "g4", prompt: "Which planet is closest to the Sun?", checker: { type: "exact", answer: "Mercury" }, probes: "Astronomy" },
      { id: "g5", prompt: "How many bits are in a byte?", checker: { type: "numeric", answer: 8, tolerance: 0 }, probes: "Computing" },
      { id: "g6", prompt: "What is the largest ocean on Earth?", checker: { type: "contains_any", values: ["Pacific"] }, probes: "Geography" },
    ],
  },
];

export function testSetHash(set: Pick<TestSet, "systemPrompt" | "items" | "version">): string {
  return hash({ v: set.version, s: set.systemPrompt, i: set.items.map((i) => [i.id, i.prompt, i.checker]) });
}

export function getTestSet(id: string): TestSet | undefined {
  return BUILT_IN_TEST_SETS.find((t) => t.id === id);
}
