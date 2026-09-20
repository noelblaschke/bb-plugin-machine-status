# Machine Status

Shows battery charge, used memory, and used local storage for connected BB
machines in a sidebar Machine status disclosure. Choose one or more metrics with
the Battery, Memory, and Storage checkboxes. Storage represents the writable system-data
volume (the Data volume on modern macOS).

The server polls once a minute and refreshes the interface when a metric's
integer percentage changes or when a machine joins, leaves, or is renamed.

By default, the list hides connected machines without a selected status. Set
**Hide machines without selected status** to off in the plugin settings to show them.
Set **Low-battery threshold** to control when a machine's battery status turns
red; it defaults to 20%.
**High-memory threshold** and **High-storage threshold** control the equivalent
used-capacity warnings and default to 90%.

## Install

From this directory, run:

```sh
bb plugin install .
```

Then enable **Machine Status** from BB's Plugins settings. It requires a BB
build that supports plugin host entries and sidebar-footer disclosures.

To install the released version from Git:

```sh
bb plugin install git:https://github.com/noelblaschke/bb-plugin-machine-status.git@v1.0.0
```
