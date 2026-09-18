// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Group, Stack, Text, Title } from '@mantine/core';
import { isObject, isString, isUUID, normalizeOperationOutcome } from '@medplum/core';
import type { OperationOutcome } from '@medplum/fhirtypes';
import { Loading, MedplumLink, OperationOutcomeAlert, StatusBadge, useMedplum } from '@medplum/react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
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

type OAuthClientLintDetailState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly result: OAuthClientLintResult }
  | { readonly kind: 'not-visible' }
  | { readonly kind: 'error'; readonly outcome: OperationOutcome };

const LIST_PATH = '/admin/oauth-security';

const LOADING_STATE: OAuthClientLintDetailState = { kind: 'loading' };

const NOT_VISIBLE_STATE: OAuthClientLintDetailState = { kind: 'not-visible' };

const MALFORMED_REPORT_MESSAGE = 'The OAuth client security report could not be read.';

const FAIL_CLOSED_COLOR = 'red';

const BADGE_COLORS = {
  pass: 'green',
  warning: 'orange',
  fail: 'red',
} as const;

const ALERT_COLORS = {
  pass: 'green',
  warning: 'yellow',
  fail: 'red',
} as const;

function isLintStatus(value: unknown): value is OAuthClientLintStatus {
  return value === 'pass' || value === 'warning' || value === 'fail';
}

function isLintFinding(value: unknown): value is OAuthClientLintFinding {
  return (
    isObject(value) &&
    isString(value.ruleId) &&
    isLintStatus(value.status) &&
    (value.redirectUri === undefined || isString(value.redirectUri)) &&
    isString(value.reason) &&
    isString(value.remediation)
  );
}

function isLintResult(value: unknown): value is OAuthClientLintResult {
  return (
    isObject(value) &&
    isString(value.id) &&
    (value.name === undefined || isString(value.name)) &&
    Array.isArray(value.redirectUris) &&
    value.redirectUris.every(isString) &&
    isLintStatus(value.status) &&
    Array.isArray(value.findings) &&
    value.findings.every(isLintFinding)
  );
}

function getStatusColor(colors: Record<OAuthClientLintStatus, string>, status: string): string {
  return isLintStatus(status) ? colors[status] : FAIL_CLOSED_COLOR;
}

function getMalformedReportState(): OAuthClientLintDetailState {
  return { kind: 'error', outcome: normalizeOperationOutcome(new Error(MALFORMED_REPORT_MESSAGE)) };
}

/**
 * Maps one OAuth client security report to the state the detail view renders.
 * @param payload - The report the endpoint returned.
 * @param clientId - The client application id the report was requested for.
 * @returns The loaded state when the report holds exactly one result naming that client, the not visible
 * state for any other result set, and the error state for a report that does not match the endpoint contract.
 */
function toDetailState(payload: unknown, clientId: string): OAuthClientLintDetailState {
  if (!isObject(payload) || !Array.isArray(payload.results)) {
    return getMalformedReportState();
  }
  const results: unknown[] = payload.results;
  if (results.length !== 1) {
    return NOT_VISIBLE_STATE;
  }
  const result = results[0];
  if (!isLintResult(result)) {
    return getMalformedReportState();
  }
  if (result.id !== clientId) {
    return NOT_VISIBLE_STATE;
  }
  return { kind: 'loaded', result };
}

function BackLink(): JSX.Element {
  return <MedplumLink to={LIST_PATH}>Back to OAuth Security</MedplumLink>;
}

function NotVisibleMessage(): JSX.Element {
  return (
    <>
      <BackLink />
      <Text c="dimmed" mt="md">
        This OAuth client is not visible in this project.
      </Text>
    </>
  );
}

function FindingAlert({ finding }: { readonly finding: OAuthClientLintFinding }): JSX.Element {
  return (
    <Alert color={getStatusColor(ALERT_COLORS, finding.status)} title={finding.ruleId}>
      {finding.redirectUri && (
        <Text size="sm" fw={500}>
          {finding.redirectUri}
        </Text>
      )}
      <Text size="sm">{finding.reason}</Text>
      <Text size="sm" mt="xs">
        <strong>Suggested fix:</strong> {finding.remediation}
      </Text>
    </Alert>
  );
}

function OAuthClientSecurityDetail({ clientId }: { readonly clientId: string }): JSX.Element {
  const medplum = useMedplum();
  const projectId = getProjectId(medplum);
  const [state, setState] = useState<OAuthClientLintDetailState>(LOADING_STATE);

  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({ _id: clientId });
    medplum
      .get('admin/projects/' + projectId + '/oauth-security?' + query.toString(), { cache: 'no-cache' })
      .then((report: OAuthClientLintReport) => {
        if (active) {
          setState(toDetailState(report, clientId));
        }
      })
      .catch((err: unknown) => {
        if (active) {
          setState({ kind: 'error', outcome: normalizeOperationOutcome(err) });
        }
      });
    return () => {
      active = false;
    };
  }, [medplum, projectId, clientId]);

  if (state.kind === 'loading') {
    return <Loading />;
  }

  if (state.kind === 'error') {
    return (
      <>
        <BackLink />
        <OperationOutcomeAlert outcome={state.outcome} mt="md" />
      </>
    );
  }

  if (state.kind === 'not-visible') {
    return <NotVisibleMessage />;
  }

  const result = state.result;
  const findings = [...result.findings].sort((a, b) => a.ruleId.localeCompare(b.ruleId));

  return (
    <>
      <Group justify="space-between" mb="md">
        <Title order={4}>{result.name || result.id}</Title>
        <StatusBadge status={result.status} color={getStatusColor(BADGE_COLORS, result.status)} variant="light" />
      </Group>
      <BackLink />
      {findings.length === 0 ? (
        <Text c="dimmed" mt="md">
          No risky patterns detected.
        </Text>
      ) : (
        <Stack gap="md" mt="md">
          {findings.map((finding) => (
            <FindingAlert key={finding.ruleId + '|' + (finding.redirectUri ?? '')} finding={finding} />
          ))}
        </Stack>
      )}
    </>
  );
}

/**
 * Read-only detail view for one OAuth client application of the current project.
 * @returns Each finding the client security report returned, with its reason, its suggested fix and the
 * redirect URI that triggered it when the finding names one.
 */
export function OAuthClientSecurityDetailPage(): JSX.Element {
  const { clientId } = useParams() as { clientId: string };

  if (!isUUID(clientId)) {
    return <NotVisibleMessage />;
  }

  return <OAuthClientSecurityDetail key={clientId} clientId={clientId} />;
}
