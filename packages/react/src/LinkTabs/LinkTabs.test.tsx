// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import { Tabs } from '@mantine/core';
import type * as MedplumCore from '@medplum/core';
import { locationUtils } from '@medplum/core';
import { MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react-hooks';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { Mocked } from 'vitest';
import { act, fireEvent, render, screen } from '../test-utils/render';
import { LinkTabs } from './LinkTabs';

const medplum = new MockClient();
const navigateMock = vi.fn();

vi.mock('@medplum/core', async (importOriginal) => ({
  ...(await importOriginal<typeof MedplumCore>()),
  locationUtils: {
    getPathname: vi.fn(),
  },
}));

const mockLocationUtils = locationUtils as Mocked<typeof locationUtils>;

describe('LinkTabs', () => {
  beforeEach(() => {
    navigateMock.mockClear();
    mockLocationUtils.getPathname.mockReturnValue('/patient/123/overview');
    vi.spyOn(window, 'open').mockImplementation(() => null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const defaultProps = {
    baseUrl: '/patient/123',
    tabs: ['Overview', 'Timeline', 'Details'],
  };

  function setup(props = {}): void {
    render(
      <MedplumProvider medplum={medplum} navigate={navigateMock}>
        <LinkTabs {...defaultProps} {...props} />
      </MedplumProvider>
    );
  }

  /**
   * Renders the tabs inside a memory router, with the Medplum navigate function wired to it.
   * @param initialPath - The initial router path.
   * @param props - Additional LinkTabs props.
   * @returns The memory router, for driving navigation.
   */
  function setupRouter(initialPath: string, props = {}): ReturnType<typeof createMemoryRouter> {
    const router = createMemoryRouter([{ path: '*', element: <LinkTabs {...defaultProps} {...props} /> }], {
      initialEntries: [initialPath],
      initialIndex: 0,
    });
    render(
      <MedplumProvider medplum={medplum} navigate={(path) => router.navigate(path)}>
        <RouterProvider router={router} />
      </MedplumProvider>
    );
    return router;
  }

  /**
   * Returns the tab button with the given label.
   * @param name - The tab label.
   * @returns The tab element.
   */
  function getTab(name: string): HTMLElement {
    return screen.getByRole('tab', { name });
  }

  test('renders tabs correctly', () => {
    setup();
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Timeline' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Details' })).toBeInTheDocument();
  });

  test('initializes with correct tab based on current URL', () => {
    mockLocationUtils.getPathname.mockReturnValue('/patient/123/timeline');
    setup();

    const timelineTab = screen.getByRole('tab', { name: 'Timeline' });
    expect(timelineTab).toHaveAttribute('aria-selected', 'true');
  });

  test('initializes with first tab when current path does not match any tab', () => {
    mockLocationUtils.getPathname.mockReturnValue('/patient/123/unknown');
    setup();

    const overviewTab = screen.getByRole('tab', { name: 'Overview' });
    expect(overviewTab).toHaveAttribute('aria-selected', 'true');
  });

  test('initializes with first tab when path is empty', () => {
    mockLocationUtils.getPathname.mockReturnValue('/patient/123');
    setup();

    const overviewTab = screen.getByRole('tab', { name: 'Overview' });
    expect(overviewTab).toHaveAttribute('aria-selected', 'true');
  });

  test('initializes with the owning tab for a nested path below the tab', () => {
    mockLocationUtils.getPathname.mockReturnValue('/patient/123/timeline/456');
    setup();

    expect(getTab('Timeline')).toHaveAttribute('aria-selected', 'true');
    expect(getTab('Overview')).toHaveAttribute('aria-selected', 'false');
  });

  test('initializes with first tab when a nested path is not below the base URL', () => {
    mockLocationUtils.getPathname.mockReturnValue('/other/456/timeline/789');
    setup();

    expect(getTab('Overview')).toHaveAttribute('aria-selected', 'true');
  });

  test('keeps the clicked tab selected when navigation does not change the location', async () => {
    setup();

    await act(async () => {
      fireEvent.click(getTab('Timeline'));
    });

    expect(navigateMock).toHaveBeenCalledWith('/patient/123/timeline');
    expect(getTab('Timeline')).toHaveAttribute('aria-selected', 'true');
  });

  test('selects the tab for the current router location', () => {
    mockLocationUtils.getPathname.mockReturnValue('/');
    setupRouter('/patient/123/timeline');

    expect(getTab('Timeline')).toHaveAttribute('aria-selected', 'true');
  });

  test('selects the owning tab for a nested router location', () => {
    mockLocationUtils.getPathname.mockReturnValue('/');
    setupRouter('/patient/123/details/8f14e45f-ceea-467a-9575-28262f2e5f31');

    expect(getTab('Details')).toHaveAttribute('aria-selected', 'true');
    expect(getTab('Overview')).toHaveAttribute('aria-selected', 'false');
  });

  test('falls back to the browser location when the router location owns no tab', () => {
    mockLocationUtils.getPathname.mockReturnValue('/patient/123/details');
    setupRouter('/');

    expect(getTab('Details')).toHaveAttribute('aria-selected', 'true');
  });

  test('tracks the route through back and forward navigation', async () => {
    mockLocationUtils.getPathname.mockReturnValue('/');
    const router = setupRouter('/patient/123/overview');

    await act(async () => {
      fireEvent.click(getTab('Timeline'));
    });
    expect(getTab('Timeline')).toHaveAttribute('aria-selected', 'true');

    await act(async () => {
      fireEvent.click(getTab('Details'));
    });
    expect(getTab('Details')).toHaveAttribute('aria-selected', 'true');

    await act(async () => {
      await router.navigate(-1);
    });
    expect(router.state.location.pathname).toBe('/patient/123/timeline');
    expect(getTab('Timeline')).toHaveAttribute('aria-selected', 'true');
    expect(getTab('Details')).toHaveAttribute('aria-selected', 'false');

    await act(async () => {
      await router.navigate(1);
    });
    expect(router.state.location.pathname).toBe('/patient/123/details');
    expect(getTab('Details')).toHaveAttribute('aria-selected', 'true');
    expect(getTab('Timeline')).toHaveAttribute('aria-selected', 'false');
  });

  test('places only the selected tab in the tab order', () => {
    mockLocationUtils.getPathname.mockReturnValue('/patient/123/timeline');
    setup();

    expect(getTab('Timeline')).toHaveAttribute('tabindex', '0');
    expect(getTab('Overview')).toHaveAttribute('tabindex', '-1');
    expect(getTab('Details')).toHaveAttribute('tabindex', '-1');

    for (const anchor of document.querySelectorAll('[role="tab"] a')) {
      expect(anchor).toHaveAttribute('tabindex', '-1');
    }
  });

  test('marks the selected tab link as the current page', () => {
    mockLocationUtils.getPathname.mockReturnValue('/patient/123/timeline');
    setup();

    expect(screen.getByRole('link', { name: 'Timeline' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Details' })).not.toHaveAttribute('aria-current');
  });

  test('omits aria-controls when no tab panels are rendered', () => {
    setup();

    expect(screen.queryAllByRole('tabpanel')).toHaveLength(0);
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab).not.toHaveAttribute('aria-controls');
    }
  });

  test('keeps aria-controls when tab panels are rendered', () => {
    setup({
      children: (
        <Tabs.Panel value="overview">
          <div>Overview panel</div>
        </Tabs.Panel>
      ),
    });

    const panel = screen.getByRole('tabpanel');
    expect(getTab('Overview')).toHaveAttribute('aria-controls', panel.id);
    expect(panel.id).not.toBe('');
  });

  test('renders the tab strip as a named navigation landmark', () => {
    setup();

    const nav = screen.getByRole('navigation', { name: 'Section' });
    expect(nav).toContainElement(screen.getByRole('tablist', { name: 'Section' }));
  });

  test('uses the given aria-label for the navigation landmark and the tab list', () => {
    setup({ 'aria-label': 'Patient' });

    expect(screen.getByRole('navigation', { name: 'Patient' })).toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: 'Patient' })).toBeInTheDocument();
  });

  test('navigates when tab is clicked', async () => {
    setup();

    const timelineTab = screen.getByRole('tab', { name: 'Timeline' });
    await act(async () => {
      fireEvent.click(timelineTab);
    });

    expect(navigateMock).toHaveBeenCalledWith('/patient/123/timeline');
  });

  test('matches tab whose value contains a query string against the pathname segment', async () => {
    mockLocationUtils.getPathname.mockReturnValue('/Patient/abc/Encounter');
    const tabs = [
      { label: 'Timeline', value: 'timeline' },
      { label: 'Visits', value: 'Encounter?_count=20&patient=abc' },
      { label: 'Tasks', value: 'Task' },
    ];
    setup({ baseUrl: '/Patient/abc', tabs });

    const visitsTab = screen.getByRole('tab', { name: 'Visits' });
    expect(visitsTab).toHaveAttribute('aria-selected', 'true');

    await act(async () => {
      fireEvent.click(visitsTab);
    });
    // Navigation must preserve the original case and full query string
    expect(navigateMock).toHaveBeenCalledWith('/Patient/abc/Encounter?_count=20&patient=abc');
  });

  test('allows middle click', async () => {
    console.error = vi.fn(); // Suppress warning for "navigation not implemented" warning

    setup();

    const timelineTab = screen.getByRole('tab', { name: 'Timeline' });
    const anchor = timelineTab.querySelector('a') as HTMLAnchorElement;

    await act(async () => {
      // Left click should be prevented, therefore fireEvent.click returns false
      expect(fireEvent.click(anchor, { button: 0 })).toBe(false);
    });

    await act(async () => {
      // Middle click should be allowed, therefore fireEvent.click returns true
      expect(fireEvent.click(anchor, { button: 1 })).toBe(true);
    });
  });
});
