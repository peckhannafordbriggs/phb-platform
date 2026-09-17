"use client";

import { useState } from "react";

const EXAMPLES: readonly string[] = [
  "What should I worry about with a 300 ton air-cooled chiller?",
  "How did we price temporary heat on a winter boiler changeover?",
  "Which jobs ran into asbestos abatement we had excluded?",
];

export function SearchPanel() {
  const [question, setQuestion] = useState("");
  const canAsk = question.trim().length > 0;

  return (
    <section className="w-full">
      <h2 className="text-center font-display text-3xl font-semibold tracking-tight sm:text-4xl">
        Ask about past projects
      </h2>
      <p className="mx-auto mt-3 max-w-xl text-center text-sm text-[var(--muted)]">
        Bids, estimates, quotes and lessons learned, in plain English. Every
        answer will cite the documents it came from.
      </p>

      <form
        className="mt-8"
        onSubmit={(event) => event.preventDefault()}
      >
        <label htmlFor="kb-question" className="sr-only">
          Ask the knowledge base a question
        </label>

        <div className="flex items-center gap-2 rounded-[var(--radius-pane)] border border-[var(--border)] bg-white p-2 shadow-[var(--shadow-soft)] focus-within:border-[var(--neutral-300)]">
          <span
            className="diamond ml-2.5 shrink-0"
            style={{ color: "var(--module-accent)" }}
            aria-hidden="true"
          />
          <input
            id="kb-question"
            type="search"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="What should I worry about with a 300 ton air-cooled chiller?"
            className="min-w-0 flex-1 bg-transparent px-2 py-2.5 text-sm placeholder:text-[var(--neutral-400)] focus:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          <button
            type="submit"
            disabled={!canAsk}
            className="shrink-0 rounded-[var(--radius-control)] px-4 py-2.5 font-display text-sm font-semibold text-white disabled:opacity-40"
            style={{ background: "var(--module-accent-ink)" }}
          >
            Ask
          </button>
        </div>
      </form>
      <div className="mt-6">
        <p className="text-center text-xs text-[var(--muted)]">
          Try one of these
        </p>
        <ul className="mt-3 flex flex-wrap justify-center gap-2">
          {EXAMPLES.map((example) => (
            <li key={example}>
              <button
                type="button"
                onClick={() => setQuestion(example)}
                className="rounded-[var(--radius-control)] border border-[var(--border)] bg-white/70 px-3 py-1.5 text-xs text-[var(--muted)] transition-colors hover:bg-white hover:text-[var(--foreground)]"
              >
                {example}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

