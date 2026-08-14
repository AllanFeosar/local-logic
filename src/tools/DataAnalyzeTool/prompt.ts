export const DESCRIPTION = `Delegates a structured-data task to local specialist tabular-ML models (TAPAS for table QA, TabPFN-v2 for tabular prediction, Chronos for forecasting) via the local model bridge. This is ONE tool with three operations, not three tools — pick exactly one operation per call and only supply the fields that operation needs.

operation "question" — answer a natural-language question grounded in a table you already have (columns + rows), e.g.:
- "Which row has the highest revenue?" given a table of products/revenue
- "How many employees are in the Engineering department?" given a table of employee records
- "What was the total for Q3?" given a table with Quarter and Amount columns
Use this instead of scanning/reasoning over the table cells yourself whenever the table has more than a handful of rows, or the question needs an exact lookup or aggregation you could get wrong by eyeballing it — the specialist grounds its answer in specific cells rather than guessing.
REQUIRES an actual table (columns + rows) — this is the hard requirement, checked BEFORE anything else about the question. A prose passage/sentence is never a table, even when the question asks for a specific number or fact extracted from it (e.g. "Here is a passage: '...is over 13,000 miles long...' Question: How long is X? Answer using only the passage." is DocumentQA, NOT this operation — there are no columns/rows here, only sentences. The "extract one specific fact/number" shape is what makes these two tools easy to confuse; the table-vs-passage distinction, not the shape of the question, is what decides it.
Same rule for a word problem that just names a couple of quantities — apply this STRUCTURALLY, not by matching any one example's exact wording: a prose sentence naming 2-4 quantities tied to short labels (days, drives, cities, products, people; with or without $ signs, %, or commas) and asking for their sum/difference/total is AskMathModel, NOT this operation, no matter what the labels or numbers are — those labels only look like row headers, they are not an actual supplied table. You need real rows/columns handed to you (e.g. an actual multi-row dataset), never just a couple of values embedded in one or two sentences.

operation "predict" — train a small tabular ML model on labeled example rows (train_features + train_labels) and predict on new rows (test_features), e.g.:
- "Given these 50 past loan applications (income, debt, credit score) and whether each defaulted, will this new applicant default?" — a category label, so classification.
- "Given these houses' square footage, bedrooms, and location score, and their sale prices, what will this new house sell for?" — a continuous number, so regression.
Needs real labeled training examples supplied in the call itself — this is not for open-ended reasoning about a dataset you're describing in prose, and it's useless with no training rows to learn from.

operation "forecast" — extrapolate a numeric time series forward, e.g.:
- "Here are the last 24 months of sales figures — forecast the next 6 months."
- "Given this week's daily server error counts, what's the likely count for the next 3 days?"
Needs an ordered numeric series (oldest value first) and how many future steps to predict.

When NOT to use:
- General questions that aren't grounded in an actual table/dataset/series you were given or have read — this tool cannot invent data, only compute over data you supply.
- Qualitative, free-text, or open-ended analysis of the data ("what trends do you notice", "summarize this table") — that's your own reasoning to do, not a specialist delegation.
- Pure math word problems with no tabular data involved — use AskMathModel instead.
- Extracting an answer from a prose passage rather than a table — use DocumentQA instead.

Output: each specialist's answer is authoritative for its narrow task — treat it as the final answer and don't re-derive or second-guess it yourself (e.g. don't manually recompute a forecast or re-scan a table the model already answered from). For "predict", the response reports which mode actually ran (task: "classify" or "regress") — read the returned values accordingly, especially if you didn't specify task explicitly and it was inferred from the label data. For "question", an empty cells list means the model could not ground the answer to specific table cells — treat that answer as low-confidence rather than authoritative, and say so rather than presenting it as certain.`

export const PROMPT = DESCRIPTION
