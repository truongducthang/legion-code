# Sidebar Specification

## ADDED Requirements

### Requirement: Projects section can be collapsed

The sidebar Projects section SHALL be collapsible via a toggle on its header.
When collapsed, the project list is hidden entirely and its vertical space is
reclaimed by the tasks section. The collapsed state SHALL persist across app
restarts.

#### Scenario: User collapses the Projects section

- **WHEN** the Projects section is expanded and the user activates the section
  header toggle
- **THEN** the project list is hidden
- **AND** the freed vertical space is given to the tasks section
- **AND** the header chevron indicates the collapsed state

#### Scenario: User expands the Projects section

- **WHEN** the Projects section is collapsed and the user activates the section
  header toggle
- **THEN** the project list is shown again
- **AND** the header chevron indicates the expanded state

#### Scenario: Collapsed state survives a restart

- **WHEN** the user has collapsed the Projects section
- **AND** the app is restarted
- **THEN** the Projects section is still collapsed

#### Scenario: Add-project control stays reachable while collapsed

- **WHEN** the Projects section is collapsed
- **THEN** the add-project control on the section header remains visible and
  usable without first expanding the section

#### Scenario: Arrow-key navigation skips hidden projects

- **WHEN** the sidebar is focused
- **AND** the Projects section is collapsed
- **THEN** pressing `↑` or `↓` does not move focus into the hidden project
  list — navigation stays within the visible task list
