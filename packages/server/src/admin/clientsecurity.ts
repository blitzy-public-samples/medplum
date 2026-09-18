// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Filter, SearchRequest, WithId } from '@medplum/core';
import {
  badRequest,
  contentTooLarge,
  DEFAULT_MAX_SEARCH_COUNT,
  DEFAULT_SEARCH_COUNT,
  forbidden,
  isUUID,
  MEDPLUM_CLI_CLIENT_ID,
  Operator,
  singularize,
} from '@medplum/core';
import type { ClientApplication, Project } from '@medplum/fhirtypes';
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
const REPORT_QUERY_PARAMS = ['_id', '_count', '_offset'] as const;

/**
 * The maximum serialized size, in UTF-8 bytes, of one report response. A client evaluation that does not fit within
 * the remaining bytes is not admitted, so no response exceeds this size; a page whose first evaluation does not fit
 * on its own is refused with `contentTooLarge` rather than returned incomplete.
 */
const MAX_REPORT_RESPONSE_BYTES = 4 * 1024 * 1024;

/** The bytes one result adds to the serialized `results` array beyond its own length: the element separator. */
const RESULT_SEPARATOR_BYTES = 1;

function reportQuery(req: Request): URLSearchParams {
  const separator = req.originalUrl.indexOf('?');
  return new URLSearchParams(separator === -1 ? '' : req.originalUrl.slice(separator + 1));
}

function findRefusedParam(query: URLSearchParams): string | undefined {
  const keys = Array.from(query.keys());
  return REPORT_QUERY_PARAMS.find(
    (name) => query.getAll(name).length > 1 || keys.some((key) => key.startsWith(name + '['))
  );
}

function parseCountParam(raw: string | null): number | undefined {
  if (raw === null || raw === '') {
    return DEFAULT_SEARCH_COUNT;
  }
  if (!UNSIGNED_INTEGER_PATTERN.test(raw)) {
    return undefined;
  }
  const count = Number.parseInt(raw, 10);
  if (count < 1) {
    return undefined;
  }
  return Math.min(count, DEFAULT_MAX_SEARCH_COUNT);
}

function parseOffsetParam(raw: string | null): number | undefined {
  if (raw === null || raw === '') {
    return 0;
  }
  if (!UNSIGNED_INTEGER_PATTERN.test(raw)) {
    return undefined;
  }
  const offset = Number.parseInt(raw, 10);
  if (!Number.isFinite(offset)) {
    return undefined;
  }
  return offset;
}

function resolveProjectId(project: WithId<Project>, requestedProjectId: string | undefined): string | undefined {
  if (project.superAdmin) {
    return requestedProjectId !== undefined && isUUID(requestedProjectId) ? requestedProjectId : project.id;
  }
  if (requestedProjectId === undefined || requestedProjectId === project.id) {
    return project.id;
  }
  return undefined;
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

  const query = reportQuery(req);
  const refusedParam = findRefusedParam(query);
  if (refusedParam) {
    sendOutcome(res, badRequest('Invalid ' + refusedParam + ' search parameter'));
    return;
  }

  const rawIds = query.get('_id');
  let ids: string[] | undefined;
  if (rawIds) {
    const requestedIds = rawIds.split(',').filter((id) => id !== '');
    if (requestedIds.length > DEFAULT_MAX_SEARCH_COUNT) {
      sendOutcome(
        res,
        badRequest('_id search parameter exceeds maximum of ' + DEFAULT_MAX_SEARCH_COUNT + ' client ids')
      );
      return;
    }
    if (!requestedIds.every(isUUID)) {
      sendOutcome(res, badRequest('Invalid _id search parameter'));
      return;
    }
    if (requestedIds.length > 0) {
      ids = requestedIds;
    }
  }

  const count = parseCountParam(query.get('_count'));
  if (count === undefined) {
    sendOutcome(res, badRequest('Invalid _count search parameter'));
    return;
  }

  const offset = parseOffsetParam(query.get('_offset'));
  if (offset === undefined) {
    sendOutcome(res, badRequest('Invalid _offset search parameter'));
    return;
  }

  const filters: Filter[] = [{ code: '_project', operator: Operator.EQUALS, value: resolvedProjectId }];
  if (ids) {
    filters.push({ code: '_id', operator: Operator.EQUALS, value: ids.join(',') });
  }

  const search: SearchRequest<ClientApplication> = {
    resourceType: 'ClientApplication',
    total: 'accurate',
    count,
    offset,
    filters,
  };

  const setting =
    resolvedProjectId === ctx.project.id
      ? ctx.project.setting
      : (await ctx.repo.readResource<Project>('Project', resolvedProjectId)).setting;

  if (offset > getConfig().maxSearchOffset) {
    const matched = await ctx.repo.search<ClientApplication>({ ...search, count: 0, offset: 0 });
    const matchedTotal = matched.total ?? 0;
    if (offset >= matchedTotal) {
      res.json({ total: matchedTotal, offset, count, results: [] });
      return;
    }
  }

  const options: OAuthClientLintOptions = {
    partialRedirectMatchEnabled: setting?.find((s) => s.name === 'allow-dangerous-redirect')?.valueBoolean === true,
    registrationDiscoverableClients: buildRegistrationDiscoverableClients(),
  };

  const bundle = await ctx.repo.search<ClientApplication>(search);
  const results: OAuthClientLintResult[] = [];
  let responseBytes = Buffer.byteLength(
    JSON.stringify({ total: bundle.total ?? count, offset, count, results: [] }),
    'utf8'
  );
  for (const entry of bundle.entry ?? []) {
    const client = entry.resource;
    if (client?.resourceType !== 'ClientApplication') {
      continue;
    }
    const result = lintOAuthClient(client, options);
    const resultBytes = Buffer.byteLength(JSON.stringify(result), 'utf8') + RESULT_SEPARATOR_BYTES;
    if (responseBytes + resultBytes > MAX_REPORT_RESPONSE_BYTES) {
      if (results.length === 0) {
        sendOutcome(
          res,
          contentTooLarge(
            'OAuth client security report for client ' +
              client.id +
              ' exceeds the maximum response size of ' +
              MAX_REPORT_RESPONSE_BYTES +
              ' bytes'
          )
        );
        return;
      }
      break;
    }
    responseBytes += resultBytes;
    results.push(result);
  }

  res.json({ total: bundle.total ?? results.length, offset, count, results });
}
