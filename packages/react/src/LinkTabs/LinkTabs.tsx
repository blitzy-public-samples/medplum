// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import type { TabsProps } from '@mantine/core';
import { Anchor, Tabs } from '@mantine/core';
import { isString, locationUtils } from '@medplum/core';
import { useMedplumNavigate } from '@medplum/react-hooks';
import type { JSX, MouseEvent } from 'react';
import { useState } from 'react';
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

export function LinkTabs(props: LinkTabsProps): JSX.Element {
  const { baseUrl, tabs: tabDefinitions, children, ...rest } = props;
  const tabs = normalizeTabDefinitions(tabDefinitions);
  const navigate = useMedplumNavigate();

  const [currentTab, setCurrentTab] = useState(() => getSelectedTab(baseUrl, tabs));

  function onTabChange(newTabName: string | null): void {
    newTabName = newTabName || tabs[0].value;
    setCurrentTab(newTabName);
    navigate(`${baseUrl}/${newTabName}`);
  }

  return (
    <Tabs value={currentTab} onChange={onTabChange} {...rest}>
      <Tabs.List className={styles.list}>
        {tabs.map((t) => (
          <Tabs.Tab key={t.value} value={t.value}>
            <Anchor className={styles.link} href={`${baseUrl}/${t.value}`} onClick={onLinkClick}>
              {t.label}
            </Anchor>
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {children}
    </Tabs>
  );
}

function normalizeTabDefinitions(tabs: string[] | TabDefinition[]): TabDefinition[] {
  return tabs.map((t) => (isString(t) ? { label: t, value: t.toLowerCase() } : t));
}

/**
 * Returns the value of the tab that the current location selects.
 * @param baseUrl - The base URL that the tab values are relative to.
 * @param tabs - The normalized tab definitions.
 * @returns The value of the tab for the current pathname, or the first tab when none applies.
 */
function getSelectedTab(baseUrl: string, tabs: TabDefinition[]): string {
  const segments = getPathSegments(locationUtils.getPathname());
  const matched =
    findTabBySegment(tabs, segments[segments.length - 1]) ??
    findTabBySegment(tabs, getBaseUrlChildSegment(baseUrl, segments));
  return (matched ?? tabs[0]).value;
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
