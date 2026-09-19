// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import type { TabsProps } from '@mantine/core';
import { Anchor, Tabs } from '@mantine/core';
import { isString, locationUtils } from '@medplum/core';
import { useMedplumNavigate } from '@medplum/react-hooks';
import type { JSX, MouseEvent, ReactNode } from 'react';
import { useState } from 'react';
import { useInRouterContext, useLocation } from 'react-router';
import { isAuxClick } from '../utils/dom';
import styles from './LinkTabs.module.css';

export interface TabDefinition {
  readonly label: string;
  readonly value: string;
}

export interface LinkTabsProps extends Omit<TabsProps, 'value' | 'onChange'> {
  readonly baseUrl: string;
  readonly tabs: string[] | TabDefinition[];
  readonly children?: React.ReactNode;
}

interface LinkTabsImplProps extends LinkTabsProps {
  readonly pathnames: string[];
  readonly locationToken: unknown;
}

interface PendingTabSelection {
  readonly value: string;
  readonly locationToken: unknown;
}

const DEFAULT_ARIA_LABEL = 'Section';

/**
 * Renders tabs that link to the routes below a base URL.
 *
 * The selected tab is the one that owns the current location: the tab matching the last path
 * segment, otherwise the tab matching the first path segment below `baseUrl`, otherwise the first
 * tab. Inside a router, the router location is consulted before the browser location. A tab the
 * user has just clicked stays selected until the location changes.
 * @param props - The LinkTabs React props.
 * @returns The LinkTabs React node.
 */
export function LinkTabs(props: LinkTabsProps): JSX.Element {
  return useInRouterContext() ? <RouterLinkTabs {...props} /> : <StaticLinkTabs {...props} />;
}

/**
 * Renders the tab strip against the React Router location, falling back to the browser location.
 * @param props - The LinkTabs React props.
 * @returns The LinkTabs React node.
 */
function RouterLinkTabs(props: LinkTabsProps): JSX.Element {
  const location = useLocation();
  const [browserPathname] = useState(() => locationUtils.getPathname());
  return <LinkTabsImpl {...props} pathnames={[location.pathname, browserPathname]} locationToken={location} />;
}

/**
 * Renders the tab strip against the browser location, for use without a router.
 * @param props - The LinkTabs React props.
 * @returns The LinkTabs React node.
 */
function StaticLinkTabs(props: LinkTabsProps): JSX.Element {
  const [pathname] = useState(() => locationUtils.getPathname());
  return <LinkTabsImpl {...props} pathnames={[pathname]} locationToken={pathname} />;
}

/**
 * Renders the tab strip for one resolved location.
 * @param props - The LinkTabs React props, plus the candidate pathnames in precedence order and a token that changes whenever the location changes.
 * @returns The LinkTabs React node.
 */
function LinkTabsImpl(props: LinkTabsImplProps): JSX.Element {
  const {
    baseUrl,
    tabs: tabDefinitions,
    children,
    pathnames,
    locationToken,
    'aria-label': ariaLabel = DEFAULT_ARIA_LABEL,
    ...rest
  } = props;
  const tabs = normalizeTabDefinitions(tabDefinitions);
  const navigate = useMedplumNavigate();
  const [pendingSelection, setPendingSelection] = useState<PendingTabSelection | undefined>(undefined);

  const currentTab =
    pendingSelection !== undefined && pendingSelection.locationToken === locationToken
      ? pendingSelection.value
      : getSelectedTab(pathnames, baseUrl, tabs);

  function onTabChange(newTabName: string | null): void {
    const value = newTabName || tabs[0].value;
    setPendingSelection({ value, locationToken });
    navigate(`${baseUrl}/${value}`);
  }

  return (
    <Tabs value={currentTab} onChange={onTabChange} {...rest}>
      <nav aria-label={ariaLabel}>
        <Tabs.List className={styles.list} aria-label={ariaLabel}>
          {tabs.map((t) => (
            <Tabs.Tab key={t.value} value={t.value} renderRoot={children ? undefined : renderTabWithoutPanel}>
              <Anchor
                className={styles.link}
                href={`${baseUrl}/${t.value}`}
                tabIndex={-1}
                aria-current={t.value === currentTab ? 'page' : undefined}
                onClick={onLinkClick}
              >
                {t.label}
              </Anchor>
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </nav>
      {children}
    </Tabs>
  );
}

function normalizeTabDefinitions(tabs: string[] | TabDefinition[]): TabDefinition[] {
  return tabs.map((t) => (isString(t) ? { label: t, value: t.toLowerCase() } : t));
}

/**
 * Renders a tab element without the `aria-controls` attribute, for a tab strip that renders no panels.
 * @param props - The element props computed for the tab.
 * @returns The tab element, without `aria-controls`.
 */
function renderTabWithoutPanel(props: Record<string, any>): ReactNode {
  const { 'aria-controls': _ariaControls, ...rootProps } = props;
  return <button {...rootProps} />;
}

/**
 * Returns the value of the tab that the given pathnames select.
 * @param pathnames - The candidate pathnames, in precedence order.
 * @param baseUrl - The base URL that the tab values are relative to.
 * @param tabs - The normalized tab definitions.
 * @returns The value of the tab for the first pathname that owns one, or the first tab when none does.
 */
function getSelectedTab(pathnames: string[], baseUrl: string, tabs: TabDefinition[]): string {
  for (const pathname of pathnames) {
    const segments = getPathSegments(pathname);
    const matched =
      findTabBySegment(tabs, segments[segments.length - 1]) ??
      findTabBySegment(tabs, getBaseUrlChildSegment(baseUrl, segments));
    if (matched) {
      return matched.value;
    }
  }
  return tabs[0].value;
}

/**
 * Returns the path segment directly below the base URL.
 * @param baseUrl - The base URL that the tab values are relative to.
 * @param segments - The segments of the current pathname.
 * @returns The segment below the base URL, or undefined when the pathname is not below it.
 */
function getBaseUrlChildSegment(baseUrl: string, segments: string[]): string | undefined {
  const baseSegments = getPathSegments(baseUrl);
  for (let i = 0; i < baseSegments.length; i++) {
    if (segments[i]?.toLowerCase() !== baseSegments[i].toLowerCase()) {
      return undefined;
    }
  }
  return segments[baseSegments.length];
}

/**
 * Returns the tab whose value matches the given path segment.
 * @param tabs - The normalized tab definitions.
 * @param segment - The path segment to match, if any.
 * @returns The matching tab definition, or undefined when no tab matches.
 */
function findTabBySegment(tabs: TabDefinition[], segment: string | undefined): TabDefinition | undefined {
  if (!segment) {
    return undefined;
  }
  const segmentLower = segment.toLowerCase();
  return tabs.find((t) => t.value.split(/[?#]/)[0].toLowerCase() === segmentLower);
}

/**
 * Splits a path into its non-empty segments.
 * @param path - The path to split.
 * @returns The non-empty segments of the path.
 */
function getPathSegments(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

function onLinkClick(e: MouseEvent): void {
  if (!isAuxClick(e)) {
    e.preventDefault();
  }
}
