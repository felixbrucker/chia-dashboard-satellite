1.19.0 / 2023-09-23
==================

* Adds support for retrieving the harvester and farmer node id.

1.18.1 / 2023-09-05
==================

* Fixes a bug which caused the chia version to be removed periodically.

1.18.0 / 2023-09-05
==================

* Adds support for retrieving the chia version.

1.17.2 / 2023-05-24
==================

* Correctly parse CAT balances.
* Skip logging in with the first fingerprint if already logged in to a wallet.

1.17.1 / 2023-04-26
==================

* Fix wallet stat collection errors.

1.17.0 / 2023-04-26
==================

* Add config option `enableCompatibilityMode` to enable/disable compatibility with older dashboards. Is automatically enabled if not set when using a different dashboard core url from foxy.
* Reduce traffic by only updating changed values.

1.16.0 / 2023-04-25
==================

* Add `updateMode` config option to change how often the satellite updates the dashboard. Possible values: `slow`, `regular`, `fast`. Default value: `regular`.

1.15.0 / 2023-04-24
==================

* Allow changing the response time sample size (default is 100) as well as the maximum number of farming infos (default is 20, maximum is 100).
* Include raw and effective capacities for plot compression.
* Update the dashboard core api url only on unavailability.

1.14.0 / 2023-02-24
==================

* Add support for fallback dashboard core urls through `chiaDashboardCoreUrlKeyPairs` config field. Users of the foxy dashboard have this auto enabled without needing to change anything.
* Bump the docker image and binaries to use node v18.
* Update dependencies.

1.13.2 / 2023-02-16
==================

* Fix precompiled binaries not working.

1.13.1 / 2023-02-16
==================

* Fix a crash when checking for running services and timeouts happened.

1.13.0 / 2022-01-22
==================

* Update dependencies.
* Increase sync interval.
* Remove unused fields from request bodies.
* Move docker image to github.

1.12.0 / 2021-11-06
==================

* Fix plotting stats on chia >= 1.2.11.

1.11.0 / 2021-08-01
==================

* Add `ogPlots` and `nftPlots` to harvester stats.

1.10.0 / 2021-06-03
==================

* Add `https://us.chiadashboard.com` dashboard core url to first run wizard.
* Decrease stats update payload size for farmer, harvester and full nodes.

1.9.2 / 2021-05-23
==================

* Fix wallets without any keys present preventing satellite initialization.

1.9.1 / 2021-05-23
==================

* Fix wallet stats unavailable when the wallet was never logged into before.

1.9.0 / 2021-05-19
==================

* Add support for selecting the `chiaDashboardCoreUrl` config option in the first run wizard.
* Show the used `chiaDashboardCoreUrl` on startup.

1.8.0 / 2021-05-19
==================

* Add support for using any chia-dashboard-core via `chiaDashboardCoreUrl` config option.

1.7.0 / 2021-05-15
==================

* Add support for only counting unique balances in the wallet summary.
* Fix a problem that could result in increased RTs when a chain re-org happens within the last 20 SPs.

1.6.2 / 2021-05-14
==================

* Fix the daemon api connection not getting properly closed on exit.

1.6.1 / 2021-05-14
==================

* Fix custom config location validation in first run wizard.

1.6.0 / 2021-05-14
==================

* Use unified service names for stats reporting.
* Increase stats updating interval.

1.5.0 / 2021-05-12
==================

* Add support for reporting harvester response times for the farmer stats.
* Fix satellite initialization throwing unhandled errors when the chia node is slow to respond.
* Fix errors being thrown with full stack traces for some failed http requests.

1.4.0 / 2021-05-11
==================

* Add the satellite version to dashboard api requests.
* Add an info log on startup showing the loaded config location.
* Show a better error message when the api key is invalid.
* Reset the plotter stats on startup as well.

1.3.0 / 2021-05-06
==================

* Add support for basic gui plotter stats.
* Add support for excluding services via `excludedServices` config option.

1.2.0 / 2021-04-28
==================

* Do not require git anymore.
* Fix a bug where throwing an error failed.

1.1.1 / 2021-04-27
==================

* Add missing shebang line.

1.1.0 / 2021-04-25
==================

* Aggregate farming infos.

1.0.1 / 2021-04-24
==================

* Initial release.
