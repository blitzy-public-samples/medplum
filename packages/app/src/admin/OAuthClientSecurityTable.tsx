// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Skeleton, Stack, Text } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import type { SearchRequest } from '@medplum/core';
import { DEFAULT_SEARCH_COUNT, normalizeErrorString, Operator } from '@medplum/core';
import type { ClientApplication, Resource } from '@medplum/fhirtypes';
import type { SearchControlAdditionalColumn, SearchLoadEvent } from '@medplum/react';
import { SearchControl, StatusBadge, useMedplum } from '@medplum/react';
import type { JSX, ReactNode } from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { getProjectId } from '../utils';

type OAuthClientLintStatus = 'pass' | 'warning' | 'fail';

interface OAuthClientLintFinding {
  readonly ruleId: string;
  readonly status: OAuthClientLintStatus;
  readonly redirectUri?: string;
  readonly reason: string;
  readonly remediation: string;
}

interface OAuthClientLintResult {
  readonly id: string;
  readonly name?: string;
  readonly redirectUris: string[];
  readonly status: OAuthClientLintStatus;
  readonly findings: OAuthClientLintFinding[];
}

interface OAuthClientLintReport {
  readonly total: number;
  readonly offset: number;
  readonly count: number;
  readonly results: OAuthClientLintResult[];
}

type SecurityCellState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'resolved'; readonly result: OAuthClientLintResult }
  | { readonly kind: 'unavailable' };

const LOADING_CELL: SecurityCellState = { kind: 'loading' };
const UNAVAILABLE_CELL: SecurityCellState = { kind: 'unavailable' };

const STATUS_COLORS = {
  pass: 'green',
  warning: 'orange',
  fail: 'red',
} as const;

function getRedirectUris(client: ClientApplication): string[] {
  const uris: string[] = [];
  if (client.redirectUri) {
    uris.push(client.redirectUri);
  }
  if (client.redirectUris) {
    uris.push(...client.redirectUris);
  }
  return uris;
}

function renderEmptyCell(): JSX.Element {
  return (
    <Text c="dimmed" size="sm">
      —
    </Text>
  );
}

/**
 * Renders the read-only OAuth client security review table for the current project.
 * @returns The table of client applications with their registered redirect URIs and security status.
 */
export function OAuthClientSecurityTable(): JSX.Element {
  const medplum = useMedplum();
  const projectId = getProjectId(medplum);
  const navigate = useNavigate();

  const [cellStates, setCellStates] = useState<Record<string, SecurityCellState>>({});
  const requestKeyRef = useRef<string>('');

  const [search, setSearch] = useState<SearchRequest>({
    resourceType: 'ClientApplication',
    fields: ['name'],
    filters: [{ code: '_project', operator: Operator.EQUALS, value: projectId }],
    count: DEFAULT_SEARCH_COUNT,
    total: 'accurate',
  });

  const handleLoad = useCallback(
    (e: SearchLoadEvent): void => {
      const entries = e.response.entry ?? [];
      const ids = Array.from(
        new Set(entries.map((entry) => entry.resource?.id).filter((id): id is string => id !== undefined))
      );
      const requestKey = ids.join(',');
      requestKeyRef.current = requestKey;

      if (ids.length === 0) {
        setCellStates({});
        return;
      }

      const loadingStates: Record<string, SecurityCellState> = {};
      for (const id of ids) {
        loadingStates[id] = LOADING_CELL;
      }
      setCellStates(loadingStates);

      medplum
        .get(`admin/projects/${projectId}/oauth-security?_id=${requestKey}`, { cache: 'no-cache' })
        .then((report: OAuthClientLintReport) => {
          if (requestKeyRef.current !== requestKey) {
            return;
          }
          const resultsById = new Map<string, OAuthClientLintResult>(
            (report?.results ?? []).map((result) => [result.id, result])
          );
          const nextStates: Record<string, SecurityCellState> = {};
          for (const id of ids) {
            const result = resultsById.get(id);
            nextStates[id] = result ? { kind: 'resolved', result } : UNAVAILABLE_CELL;
          }
          setCellStates(nextStates);
        })
        .catch((err: unknown) => {
          if (requestKeyRef.current !== requestKey) {
            return;
          }
          const nextStates: Record<string, SecurityCellState> = {};
          for (const id of ids) {
            nextStates[id] = UNAVAILABLE_CELL;
          }
          setCellStates(nextStates);
          showNotification({ color: 'red', message: normalizeErrorString(err), autoClose: false });
        });
    },
    [medplum, projectId]
  );

  const additionalColumns = useMemo<SearchControlAdditionalColumn[]>(
    () => [
      {
        name: 'Redirect URIs',
        renderCell: (resource: Resource): ReactNode => {
          const uris = getRedirectUris(resource as ClientApplication);
          if (uris.length === 0) {
            return renderEmptyCell();
          }
          return (
            <Stack gap="xs">
              {uris.map((uri, index) => (
                <Text key={`${index}-${uri}`} size="sm">
                  {uri}
                </Text>
              ))}
            </Stack>
          );
        },
      },
      {
        name: 'Security',
        renderCell: (resource: Resource): ReactNode => {
          const cellState = resource.id ? cellStates[resource.id] : undefined;
          if (cellState?.kind === 'resolved') {
            const status = cellState.result.status;
            return <StatusBadge status={status} color={STATUS_COLORS[status]} variant="light" />;
          }
          if (cellState?.kind === 'loading') {
            return <Skeleton height={22} width={70} radius="xl" />;
          }
          return renderEmptyCell();
        },
      },
    ],
    [cellStates]
  );

  return (
    <SearchControl
      search={search}
      hideToolbar
      hideFilters
      onChange={(e) => setSearch(e.definition)}
      onClick={(e) => navigate(`./${e.resource.id}`)}
      onAuxClick={(e) => navigate(`./${e.resource.id}`)}
      onLoad={handleLoad}
      additionalColumns={additionalColumns}
    />
  );
}
