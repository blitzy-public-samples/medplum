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
import { indexRegistrationDiscoverableClients, lintOAuthClient } from '../oauth/clientlint';
import { getClientRedirectUris, getStandardClientById } from '../oauth/clients';

const UNSIGNED_INTEGER_PATTERN = /^\d+$/;
const REPORT_QUERY_PARAMS = ['_id', '_count', '_offset'] as const;

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
  if (requestedProjectId === undefined) {
    return project.id;
  }
  if (project.superAdmin) {
    return requestedProjectId;
  }
  return requestedProjectId === project.id ? project.id : undefined;
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

  const requestedProjectId = singularize(req.params.projectId);
  if (requestedProjectId !== undefined && !isUUID(requestedProjectId)) {
    sendOutcome(res, badRequest('Invalid project id'));
    return;
  }

  const resolvedProjectId = resolveProjectId(ctx.project, requestedProjectId);
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

  const options: OAuthClientLintOptions = {
    partialRedirectMatchEnabled: setting?.find((s) => s.name === 'allow-dangerous-redirect')?.valueBoolean === true,
    registrationDiscoverableClients: indexRegistrationDiscoverableClients(buildRegistrationDiscoverableClients()),
  };

  const bundle = await ctx.repo.search<ClientApplication>(search);
  const results: OAuthClientLintResult[] = [];
  for (const entry of bundle.entry ?? []) {
    const client = entry.resource;
    if (client?.resourceType === 'ClientApplication') {
      results.push(lintOAuthClient(client, options));
    }
  }

  res.json({ total: bundle.total ?? results.length, offset, count, results });
}
