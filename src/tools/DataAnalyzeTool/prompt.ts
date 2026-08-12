export const DESCRIPTION = `Delegates a structured-data task to local specialist tabular-ML models (TAPAS for table QA, TabPFN-v2 for tabular prediction, Chronos for forecasting) via the local model bridge. This is ONE tool with three operations, not three tools — pick exactly one operation per call and only supply the fields that operation needs.

operation "question" — answer a natural-language question grounded in a table you already have (columns + rows), e.g.:
- "Which row has the highest revenue?" given a table of products/revenue
- "How many employees are in the Engineering department?" given a table of employee records
- "What was the total for Q3?" given a table with Quarter and Amount columns
Use this instead of scanning/reasoning over the table cells yourself whenever the table has more than a handful of rows, or the question needs an exact lookup or aggregation you could get wrong by eyeballing it — the specialist grounds its answer in specific cells rather than guessing.

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
