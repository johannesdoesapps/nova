import type { ClaimHandoff } from "./local-store";

/** A fictional, clearly-labelled example so the workflow can be tried without search keys. */
export const EXAMPLE: ClaimHandoff = {
  question: "Did the Riverton four-day work week pilot improve productivity?",
  answer: `The Riverton pilot ran for six months across 41 companies [1]. Output per employee rose 8% during the pilot [1], and sick days fell by a third [2].

One analysis found output per employee rose 24% [3]. Most companies chose to continue the four-day week after the pilot ended [1].

Interpretation: This suggests shorter weeks pay for themselves in most office jobs.

The pilot also reduced commuting emissions by 15%. Cities should adopt four-day weeks for public employees.`,
  sources: [
    {
      index: 1,
      url: "https://www.example.gov/riverton-pilot-final-report",
      title: "Riverton Four-Day Week Pilot: Final Report (fictional example)",
      publishedAt: "2026-03-14",
      provider: null,
      text: "The Riverton pilot ran for six months and included 41 companies with 2,900 employees. Across participating firms, output per employee rose 8% compared with the same period a year earlier. Of the 41 companies, 35 chose to continue the four-day week after the pilot ended. Participation was voluntary, so firms that expected to benefit may have been more likely to join.",
    },
    {
      index: 2,
      url: "https://www.example-news.com/riverton-sick-days",
      title: "Sick days drop in Riverton trial (fictional example)",
      publishedAt: "2026-03-20",
      provider: null,
      text: "Employers in the Riverton trial reported that sick days fell by about a third over the six months. Managers said staff seemed more rested, though the report did not track the causes.",
    },
    {
      index: 3,
      url: "https://consultant-blog.example.com/four-day-week-wins",
      title: "Why the four-day week wins (fictional example)",
      publishedAt: null,
      provider: null,
      text: "Our analysis of the Riverton numbers shows output per employee rose 4% once seasonal effects are removed. Critics who claim bigger gains are cherry-picking the best firms.",
    },
  ],
};
