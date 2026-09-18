// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Filter, SearchRequest, WithId } from '@medplum/core';
import {
  badRequest,
  DEFAULT_MAX_SEARCH_COUNT,
  DEFAULT_SEARCH_COUNT,
  forbidden,
  isUUID,
  MEDPLUM_CLI_CLIENT_ID,
  Operator,
  singularize,
} from '@medplum/core';
import type { Bundle, ClientApplication, Project } from '@medplum/fhirtypes';
import type { Request, Response } from 'express';
import { getConfig } from '../config/loader';
import { getAuthenticatedContext } from '../context';
import { sendOutcome } from '../fhir/outcomes';
import type {
  OAuthClientLintOptions,
  OAuthClientLintResult,
  RegistrationDiscoverableClient,
} from '../oauth/clientlint';
import { lintOAuthClient } from '../oauth/clientlint';
import { getClientRedirectUris, getStandardClientById } from '../oauth/clients';

const UNSIGNED_INTEGER_PATTERN = /^\d+$/;

/**
 * The client applications the caller asked for, or every client application of the project when `ids` is absent.
 */
export interface RequestedClientIds {
  readonly ids?: string[];
}

function isSingleQueryValue(raw: unknown): raw is string | undefined {
  return raw === undefined || typeof raw === 'string';
}

/**
 * Parses the `_id` query parameter of the OAuth client security report.
 *
 * The parameter is accepted only as a single comma-separated list: a repeated `_id=`, which Express parses as an
 * array, is refused. Empty segments are discarded, and a value that reduces to an empty list is treated as an absent
 * parameter. A value that is not a client application id, or a list longer than `DEFAULT_MAX_SEARCH_COUNT`, is
 * refused.
 * @param raw - The raw `_id` query parameter value, as Express parsed it.
 * @returns The requested ids, an empty object when no id filter was requested, or undefined when the parameter is
 * refused.
 */
export function parseClientIdsParam(raw: unknown): RequestedClientIds | undefined {
  if (!isSingleQueryValue(raw)) {
    return undefined;
  }
  if (raw === undefined) {
    return {};
  }
  const ids = raw.split(',').filter((id) => id !== '');
  if (ids.length === 0) {
    return {};
  }
  if (ids.length > DEFAULT_MAX_SEARCH_COUNT || !ids.every(isUUID)) {
    return undefined;
  }
  return { ids };
}

function parseCountParam(raw: unknown): number | undefined {
  if (!isSingleQueryValue(raw)) {
    return undefined;
  }
  if (raw === undefined || raw === '') {
    return DEFAULT_SEARCH_COUNT;
  }
  if (!UNSIGNED_INTEGER_PATTERN.test(raw)) {
    return undefined;
  }
  const count = Number.parseInt(raw, 10);
  if (Number.isNaN(count) || count < 1) {
    return undefined;
  }
  return Math.min(count, DEFAULT_MAX_SEARCH_COUNT);
}

function parseOffsetParam(raw: unknown): number | undefined {
  if (!isSingleQueryValue(raw)) {
    return undefined;
  }
  if (raw === undefined || raw === '') {
    return 0;
  }
  if (!UNSIGNED_INTEGER_PATTERN.test(raw)) {
    return undefined;
  }
  const offset = Number.parseInt(raw, 10);
  if (!Number.isFinite(offset) || offset < 0) {
    return undefined;
  }
  return offset;
}

function resolveProjectId(project: WithId<Project>, requestedProjectId: string | undefined): string | undefined {
  if (project.superAdmin) {
    if (requestedProjectId && isUUID(requestedProjectId)) {
      return requestedProjectId;
    }
    return project.id;
  }
  if (requestedProjectId && requestedProjectId !== project.id) {
    return undefined;
  }
  return project.id;
}

/**
 * Issues one client application search with the repository and access policy of the authenticated caller.
 */
export type ClientApplicationSearch = (
  search: SearchRequest<ClientApplication>
) => Promise<Bundle<WithId<ClientApplication>>>;

/**
 * One page of client applications, together with the accurate total of the matching set.
 */
interface ClientApplicationPage {
  readonly total: number;
  readonly clients: WithId<ClientApplication>[];
}

/**
 * Collects the client applications of one search bundle.
 * @param bundle - The search bundle.
 * @returns The client applications of the bundle entries, in bundle order.
 */
function collectClients(bundle: Bundle<WithId<ClientApplication>>): WithId<ClientApplication>[] {
  const clients: WithId<ClientApplication>[] = [];
  for (const entry of bundle.entry ?? []) {
    const client = entry.resource;
    if (client?.resourceType === 'ClientApplication') {
      clients.push(client);
    }
  }
  return clients;
}

/**
 * Reads the cursor of the next page from a search bundle.
 * @param bundle - The search bundle.
 * @returns The cursor carried by the bundle "next" link, or undefined when the bundle is the last page.
 */
function nextCursorOf(bundle: Bundle<WithId<ClientApplication>>): string | undefined {
  const nextUrl = bundle.link?.find((link) => link.relation === 'next')?.url;
  if (!nextUrl) {
    return undefined;
  }
  try {
    return new URL(nextUrl).searchParams.get('_cursor') ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Collects one page of client applications by walking the matching set with cursor pagination.
 *
 * Each search reads a window of `DEFAULT_MAX_SEARCH_COUNT` client applications from the start of the remaining set,
 * carrying the cursor of the previous window, and the walk stops at the window that fills the page or at the last
 * window of the set.
 * @param search - Issues one client application search.
 * @param base - The base search request, carrying the forced filters and the sort rule.
 * @param offset - The number of client applications to skip before the page starts.
 * @param count - The maximum number of client applications on the page.
 * @returns The client applications of the requested page, which is short or empty at the end of the set.
 */
export async function collectPageByCursor(
  search: ClientApplicationSearch,
  base: SearchRequest<ClientApplication>,
  offset: number,
  count: number
): Promise<WithId<ClientApplication>[]> {
  const page: WithId<ClientApplication>[] = [];
  let skipped = 0;
  let cursor: string | undefined;

  do {
    const bundle = await search({
      ...base,
      count: DEFAULT_MAX_SEARCH_COUNT,
      offset: 0,
      cursor,
      total: undefined,
    });
    for (const client of collectClients(bundle)) {
      if (skipped < offset) {
        skipped++;
      } else if (page.length < count) {
        page.push(client);
      }
      if (page.length === count) {
        return page;
      }
    }
    cursor = nextCursorOf(bundle);
  } while (cursor);

  return page;
}

/**
 * Reads one page of the client applications matching a search request.
 *
 * An offset within the repository offset ceiling is read with a single search. A deeper offset, which the repository
 * refuses, is answered by reading the accurate total once and then walking the matching set with cursor pagination
 * until the requested page is reached.
 * @param search - Issues one client application search.
 * @param base - The base search request, carrying the forced filters and the sort rule.
 * @param offset - The normalised `_offset` of the requested page.
 * @param count - The normalised `_count` of the requested page.
 * @returns The accurate total of matching client applications and the client applications of the requested page.
 */
async function readClientApplicationPage(
  search: ClientApplicationSearch,
  base: SearchRequest<ClientApplication>,
  offset: number,
  count: number
): Promise<ClientApplicationPage> {
  const maxSearchOffset = getConfig().maxSearchOffset;
  if (maxSearchOffset === undefined || offset <= maxSearchOffset) {
    const bundle = await search({ ...base, count, offset, total: 'accurate' });
    const clients = collectClients(bundle);
    return { total: bundle.total ?? clients.length, clients };
  }

  const probe = await search({ ...base, count: 1, offset: 0, total: 'accurate' });
  const total = probe.total ?? collectClients(probe).length;
  if (offset >= total) {
    return { total, clients: [] };
  }
  return { total, clients: await collectPageByCursor(search, base, offset, count) };
}

function buildRegistrationDiscoverableClients(): RegistrationDiscoverableClient[] {
  const entries: RegistrationDiscoverableClient[] = [];
  const builtInClient = getStandardClientById(MEDPLUM_CLI_CLIENT_ID);
  if (builtInClient) {
    entries.push({
      id: MEDPLUM_CLI_CLIENT_ID,
      redirectUris: getClientRedirectUris(builtInClient),
      source: 'built-in',
    });
  }
  for (const configuredClient of getConfig().defaultOAuthClients ?? []) {
    entries.push({
      id: configuredClient.id,
      redirectUris: getClientRedirectUris(configuredClient),
      source: 'config',
    });
  }
  return entries;
}

/**
 * Handles requests to "GET /admin/projects/{projectId}/oauth-security".
 *
 * Reads the client applications of the reported project, evaluates each one, and responds with
 * `{ total, offset, count, results }` where every result carries the client id, name, redirect URIs, aggregate
 * status and findings. Accepts the optional query parameters `_id` (a single comma-separated list of client ids),
 * `_count` and `_offset`, and refuses a malformed value with an `invalid` outcome. An `_offset` deeper than the
 * repository offset ceiling is answered with the same envelope: the page it names, or an empty `results` and the
 * accurate `total` when it lies beyond the result set.
 * @param req - The request.
 * @param res - The response.
 */
export async function clientSecurityHandler(req: Request, res: Response): Promise<void> {
  const ctx = getAuthenticatedContext();

  const resolvedProjectId = resolveProjectId(ctx.project, singularize(req.params.projectId));
  if (!resolvedProjectId) {
    sendOutcome(res, forbidden);
    return;
  }

  const requestedIds = parseClientIdsParam(req.query['_id']);
  if (!requestedIds) {
    sendOutcome(res, badRequest('Invalid _id search parameter'));
    return;
  }

  const count = parseCountParam(req.query['_count']);
  if (count === undefined) {
    sendOutcome(res, badRequest('Invalid _count search parameter'));
    return;
  }

  const offset = parseOffsetParam(req.query['_offset']);
  if (offset === undefined) {
    sendOutcome(res, badRequest('Invalid _offset search parameter'));
    return;
  }

  const filters: Filter[] = [{ code: '_project', operator: Operator.EQUALS, value: resolvedProjectId }];
  if (requestedIds.ids) {
    filters.push({ code: '_id', operator: Operator.EQUALS, value: requestedIds.ids.join(',') });
  }

  const search: SearchRequest<ClientApplication> = {
    resourceType: 'ClientApplication',
    total: 'accurate',
    count,
    offset,
    filters,
    sortRules: [{ code: '_lastUpdated' }],
  };

  const setting =
    resolvedProjectId === ctx.project.id
      ? ctx.project.setting
      : (await ctx.repo.readResource<Project>('Project', resolvedProjectId)).setting;

  const options: OAuthClientLintOptions = {
    partialRedirectMatchEnabled: setting?.find((s) => s.name === 'allow-dangerous-redirect')?.valueBoolean === true,
    registrationDiscoverableClients: buildRegistrationDiscoverableClients(),
  };

  const page = await readClientApplicationPage(
    (request) => ctx.repo.search<ClientApplication>(request),
    search,
    offset,
    count
  );

  const results: OAuthClientLintResult[] = page.clients.map((client) => lintOAuthClient(client, options));

  res.json({ total: page.total, offset, count, results });
}
