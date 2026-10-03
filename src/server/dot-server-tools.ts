import { parallelSources } from './parallel.js';
import { ComputerService } from './computer-service.js';
import { computerTools } from './computer-tools.js';
import { pageAccess, pageTools } from './page-tools.js';
import { defineTool, type ToolDefinition } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import { browserResponse } from './research.js';
import type { Platform } from './platform.js';

/** Shared server tools for Slack, web and Telegram; permissions are checked on every call. */
export function dotServerTools(
  platform: Pick<Platform, 'store' | 'workspace' | 'config'>,
  dotId: string,
  threadId: string,
  check: () => void,
  signal: AbortSignal,
) {
  const { store, workspace, config } = platform;
  const dot = workspace.dot(dotId);
  if (!dot) throw new Error('Dot unavailable.');
  workspace.requireThread(threadId, dotId);
  const initialSettings = store.settings();
  const computer = new ComputerService(
    workspace,
    config,
    () => store.settings().paused,
  );
  const tools: ToolDefinition[] =
    dot.researchAllowed &&
    initialSettings.researchAllowed &&
    config.webSearchProvider === 'browser' &&
    !computer.configured
      ? [
          defineTool({
            name: 'read_public_page',
            description:
              'Read a provided canonical public HTTP(S) URL in a separate read-only browser, returning source evidence. No web search, redirects, authenticated sites, or write actions.',
            parameters: z.object({ url: z.string().url().max(2048) }),
            execute: async ({ url }) => {
              check();
              if (!store.settings().researchAllowed)
                throw new Error('Research permission is disabled.');
              if (!config.browserUrl || !config.browserSecret)
                throw new Error(
                  'Browser is not configured: set BROWSER_URL and BROWSER_SECRET.',
                );
              const response = await fetch(
                `${config.browserUrl.replace(/\/$/, '')}/browse`,
                {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${config.browserSecret}`,
                  },
                  body: JSON.stringify({ url }),
                  signal: signal,
                },
              );
              if (!response.ok)
                throw new Error(
                  `Browser returned HTTP ${response.status}. Provide a public canonical page URL; redirects and private addresses are blocked.`,
                );
              const page = browserResponse.parse(await response.json());
              check();
              workspace.saveCapture(threadId, {
                sample: false,
                text: page.text,
                sources: [
                  {
                    title: page.title,
                    url: page.url,
                    excerpt: page.text.slice(0, 320),
                  },
                ],
                screenshot: page.screenshot,
              });
              return {
                title: page.title,
                url: page.url,
                text: page.text.slice(0, 24000),
              };
            },
          }),
        ]
      : [];
  if (
    dot.researchAllowed &&
    initialSettings.researchAllowed &&
    config.webSearchProvider === 'browser' &&
    computer.configured
  ) {
    const capture = async (url: string) => {
      check();
      if (!store.settings().researchAllowed)
        throw new Error('Research permission is disabled.');
      const page = z
        .object({
          title: z.string(),
          url: z.string().url(),
          text: z.string(),
          links: z
            .array(z.object({ title: z.string(), url: z.string().url() }))
            .optional(),
        })
        .parse(
          await computer.action(dotId, 'browse', { url }, 'agent', signal),
        );
      check();
      workspace.saveCapture(threadId, {
        sample: false,
        text: page.text,
        sources: [
          {
            title: page.title,
            url: page.url,
            excerpt: page.text.slice(0, 320),
          },
        ],
      });
      return { ...page, text: page.text.slice(0, 24000) };
    };
    tools.push(
      defineTool({
        name: 'read_public_page',
        description:
          'Read a public page in this Dot computer and save source evidence. Requires browser and research permissions.',
        parameters: z.object({ url: z.string().url().max(2048) }),
        execute: ({ url }) => capture(url),
      }),
      defineTool({
        name: 'search_web',
        description:
          'Search public web sources using this Dot browser. Sends the query to DuckDuckGo and returns links for further reading and citations.',
        parameters: z.object({ query: z.string().trim().min(1).max(200) }),
        execute: ({ query }) =>
          capture('https://duckduckgo.com/?q=' + encodeURIComponent(query)),
      }),
    );
  }
  if (
    dot.researchAllowed &&
    initialSettings.researchAllowed &&
    (config.webSearchProvider ?? 'parallel') === 'parallel'
  ) {
    const capture = async (
      objective: string,
      urls?: string[],
      searchQueries?: string[],
    ) => {
      const limitations: string[] = [];
      check();
      const sources = await parallelSources(
        {
          objective,
          urls,
          sessionId: threadId,
          searchQueries,
          onWarning: (message) => limitations.push(message),
        },
        config,
        signal,
      );
      check();
      workspace.saveCapture(threadId, {
        sample: false,
        text:
          sources
            .map((page) => `${page.title}\n${page.url}\n${page.text}`)
            .join('\n\n') +
          (limitations.length
            ? `\n\nSource limitations: ${limitations.join(' ')}`
            : ''),
        sources: sources.map((page) => ({
          title: page.title,
          url: page.url,
          excerpt: page.text.slice(0, 320),
        })),
      });
      return { sources, limitations };
    };
    tools.push(
      defineTool({
        name: 'search_web',
        description:
          'Search public web sources and read relevant excerpts for a research question. Return source URLs for citations. Sends the question to Parallel.',
        parameters: z.object({
          objective: z.string().min(1).max(4000),
          search_queries: z
            .array(z.string().min(1).max(200))
            .min(1)
            .max(3)
            .describe(
              'One to three concise keyword queries, ideally 3–6 words each.',
            ),
        }),
        execute: ({ objective, search_queries }) =>
          capture(objective, undefined, search_queries),
      }),
      defineTool({
        name: 'read_public_page',
        description:
          'Extract source evidence from a public HTTP(S) URL with Parallel. No authenticated browsing or write actions.',
        parameters: z.object({ url: z.string().url().max(2048) }),
        execute: ({ url }) =>
          capture('Read the page for relevant source evidence.', [url]),
      }),
    );
  }
  const pages = pageAccess(workspace, dot.spaceId, threadId, check);
  const pageContext = pages.context();
  const memories =
    initialSettings.memoryAllowed && dot.memoryAllowed
      ? store.memories().map((memory) => memory.text)
      : [];
  const serverTools = [
    ...tools,
    ...pageTools(pages),
    ...(computer.configured
      ? computerTools(computer, dot.id, check, signal)
      : []),
  ];
  return {
    serverTools,
    memories,
    pageContext,
    computerConfigured: computer.configured,
  };
}
