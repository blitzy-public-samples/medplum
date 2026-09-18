// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import {
  Anchor,
  Box,
  Group,
  AppShell as MantineAppShell,
  Menu,
  Stack,
  Text,
  UnstyledButton,
  VisuallyHidden,
} from '@mantine/core';
import { formatHumanName } from '@medplum/core';
import { useMedplum, useMedplumProfile } from '@medplum/react-hooks';
import { IconChevronDown } from '@tabler/icons-react';
import type { JSX, MouseEvent, ReactNode } from 'react';
import { useState } from 'react';
import { ResourceAvatar } from '../ResourceAvatar/ResourceAvatar';
import type { AppShellAnnouncement } from './AnnouncementBanners';
import { AnnouncementBanners } from './AnnouncementBanners';
import classes from './Header.module.css';
import { HeaderDropdown } from './HeaderDropdown';
import headerDropdownClasses from './HeaderDropdown.module.css';
import { HeaderSearchInput } from './HeaderSearchInput';

/**
 * The DOM id of the app shell main content region, and the target of the header skip link.
 * `AppShell` assigns this id to `AppShell.Main`.
 */
const MAIN_CONTENT_ID = 'medplum-main-content';

/**
 * Moves keyboard focus to the app shell main content region.
 * Falls back to default anchor navigation when the region is not present.
 * @param event - The skip link click event.
 */
function focusMainContent(event: MouseEvent<HTMLAnchorElement>): void {
  const mainContent = document.getElementById(MAIN_CONTENT_ID);
  if (mainContent) {
    event.preventDefault();
    mainContent.focus();
  }
}

export interface HeaderProps {
  readonly pathname?: string;
  readonly searchParams?: URLSearchParams;
  readonly headerSearchDisabled?: boolean;
  readonly logo: ReactNode;
  readonly version?: string;
  readonly navbarOpen?: boolean;
  readonly navbarToggle: () => void;
  readonly notifications?: ReactNode;
  readonly announcements?: AppShellAnnouncement[];
  readonly onDismissAnnouncement?: (announcement: AppShellAnnouncement) => void;
}

export function Header(props: HeaderProps): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [userMenuOpened, setUserMenuOpened] = useState(false);
  const projectDisplay = medplum.getProject()?.name ?? medplum.getActiveLogin()?.project.display;

  return (
    <MantineAppShell.Header p={0} style={{ zIndex: 101 }} aria-label="Application header">
      <Box p={8} h={60}>
        <Anchor href={`#${MAIN_CONTENT_ID}`} className={classes.skipLink} onClick={focusMainContent}>
          Skip to main content
        </Anchor>
        <Group justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap" className={classes.headerStart}>
            <UnstyledButton
              className={classes.logoButton}
              aria-expanded={props.navbarOpen}
              aria-controls="navbar"
              onClick={() => props.navbarToggle()}
            >
              {props.logo}
            </UnstyledButton>
            {!props.headerSearchDisabled && (
              <Box role="search" aria-label="Search patients and orders" className={classes.search}>
                <HeaderSearchInput pathname={props.pathname} searchParams={props.searchParams} />
              </Box>
            )}
          </Group>
          <Group gap="lg" pr="sm" wrap="nowrap">
            {props.notifications}
            <Menu
              width={260}
              shadow="md"
              radius="md"
              position="bottom-end"
              transitionProps={{ transition: 'fade-down' }}
              opened={userMenuOpened}
              onClose={() => setUserMenuOpened(false)}
            >
              <Menu.Target>
                <UnstyledButton
                  className={classes.user}
                  data-active={userMenuOpened || undefined}
                  onClick={() => setUserMenuOpened((o) => !o)}
                >
                  <Group gap={7} wrap="nowrap">
                    <ResourceAvatar
                      value={profile}
                      radius="xl"
                      size={24}
                      classNames={{ placeholder: classes.avatarPlaceholder }}
                    />
                    <Stack gap={0} className={classes.userInfo}>
                      <Text size="sm" className={classes.userName} truncate>
                        {formatHumanName(profile?.name?.[0])}
                      </Text>
                      {projectDisplay && (
                        <Text size="xs" className={classes.userProject} title={projectDisplay} truncate>
                          {projectDisplay}
                        </Text>
                      )}
                    </Stack>
                    <IconChevronDown size={12} stroke={1.5} />
                  </Group>
                  <VisuallyHidden>User menu</VisuallyHidden>
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown className={headerDropdownClasses.dropdown}>
                <HeaderDropdown version={props.version} />
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </Box>
      {!!props.announcements?.length && props.onDismissAnnouncement && (
        <AnnouncementBanners announcements={props.announcements} onDismiss={props.onDismissAnnouncement} />
      )}
    </MantineAppShell.Header>
  );
}
