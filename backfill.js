require([
    'underscore',
    'jquery',
    'splunkjs/mvc',
    'splunkjs/mvc/simplexml/ready!'
], function (_, $, mvc) {

    const validSearchPropsRegex = /^(?:action\.[^.]+|action\.[^.]+\.[^.]+|action\.summary_index\._type|action\.summary_index\.force_realtime_schedule|actions|alert\.digest_mode|alert\.expires|alert\.severity|alert\.suppress|alert\.suppress\.fields|alert\.suppress\.group_name|alert\.suppress\.period|alert\.track|alert_comparator|alert_condition|alert_threshold|alert_type|allow_skew|args\.[^.]+|auto_summarize|auto_summarize\.command|auto_summarize\.cron_schedule|auto_summarize\.dispatch\.[^.]+|auto_summarize\.max_concurrent|auto_summarize\.max_disabled_buckets|auto_summarize\.max_summary_ratio|auto_summarize\.max_summary_size|auto_summarize\.max_time|auto_summarize\.suspend_period|auto_summarize\.timespan|cron_schedule|description|disabled|dispatch\.[^.]+|dispatchAs|displayview|durable\.[^.]+|is_scheduled|is_visible|max_concurrent|name|next_scheduled_time|qualifiedSearch|realtime_schedule|request\.ui_dispatch_(?:app|view)|restart_on_searchpeer_add|run_n_times|run_on_startup|schedule_priority|schedule_window|search|vsid|workload_pool)$/;
    const service = mvc.createService({'owner': 'admin', 'app': 'search'});
    const tokens = mvc.Components.get("default", { create: true });
    const savedSearches = service.savedSearches();

    const $pri = $("#pri_checkboxes");

    $(".btn-select-all").click(function () {
        const $switches = $("#pri_checkboxes").find('div[data-test="switch"]');
        $switches.each(function () {
            if (this.getAttribute("data-test-selected") === 'false') {
                $("button", this).click();
            }
        });
    });

    $(".btn-deselect-all").click(function () {
        const $switches = $("#pri_checkboxes").find('div[data-test="switch"]');
        $switches.each(function () {
            if (this.getAttribute("data-test-selected") === 'true') {
                $("button", this).click();
            }
        });
    });

    $('.btn-create-backfill-searches').click(async function() {
        const $btn = $(this);

        if ($btn.hasClass('disabled')) return; // prevent double-click

        $btn.addClass('disabled');
        $pri.find("button").prop("disabled", true);

        const timeTokens = {
            event_time_earliest: tokens.get('event_time.earliest'),
            event_time_latest: tokens.get('event_time.latest'),
            index_time_earliest: tokens.get('index_time.earliest'),
            index_time_latest: tokens.get('index_time.latest')
        }

        const checkedSearches = $pri.find('div[data-test-selected="true"]').map(function () {
            return $(this).data("test-value");
        }).get();

        try {
            const fetchedSearches = await fetchSavedSearches();
 
            for (const searchName of checkedSearches) {
                
                const $current_row = $pri.find(`div[data-test-value="${searchName}"]`);
                const $status = createStatusEl($current_row);

                setStatus($status, 'Cloning backfill search...', 'in-progress')
                
                const original = fetchedSearches.item(searchName);
                const props = buildBackfillProperties(original, timeTokens);

                let newSearch;

                try {
                    newSearch = await createSavedSearch(props);
                } catch (e) {
                    const msg = e.data?.messages?.[0]?.text || e.message || e;
                    setStatus($status, msg, 'error');
                    continue;
                }

                setStatus($status, 'Updating scope and owner...', 'in-progress')

                try {
                    await updateSavedSearchACL(newSearch, {
                        'sharing': 'global',
                        'owner': 'admin'
                    });

                } catch (e) {
                    setStatus($status, `Search created but unable to update to the global scope. Does the search already exist?`, 'error');
                    continue;
                }

                setStatus($status, 'Dispatching...', 'in-progress')

                let job;
                try {
                    job = await dispatchSavedSearch(newSearch);
                    await trackJob(job);
                } catch (e) {
                    setStatus($status, `Search created but unable to dispatch: ${e}`, 'error');
                    continue;
                }

                const sid = job?.properties()?.sid;
                const state = job?.properties()?.dispatchState;

                if (state === "FAILED") {
                    setStatus($status, `Search dispatched but failed. View the <a target="_blank" href="/app/search/job_manager?filter=${sid}">job</a> for details.`, 'error');
                    continue;
                }

                setStatus($status, 'Deleting backfill search...', 'in-progress')

                try {
                    await deleteSavedSearch(newSearch);
                } catch (e) {
                    setStatus($status, `Search dispatched, but unable to delete: ${e}`, 'error');
                    continue;
                }

                setStatus($status, `Complete. View the <a target="_blank" href="/app/search/job_manager?filter=${sid}">search job</a> for details`, 'done');
            }            
        } catch (e) {
            console.error(`Error fetching saved searches or creating backfill: ${e}`);
        }

        $btn.removeClass('disabled');
        $pri.find("button").prop("disabled", false);
    });

    function createStatusEl($container) {
        $container.find('.status-message').remove();
        return $('<div class="status-message"></div>').appendTo($container);
    }

    function setStatus($el, message, status) {
        $el.html(message);
        $el.removeClass('error in-progress done').addClass(status)
    }

    function filterSearchProperties(properties) {
        return Object.fromEntries(
            Object.entries(properties).filter(([key]) =>
                validSearchPropsRegex.test(key)
            )
        );
    }

    function buildBackfillProperties(origSearch, timeTokens) {
        const props = filterSearchProperties(origSearch.properties());
        const name = origSearch.name;

        props.is_scheduled = 0;
        props.name = `${name} - Backfill`;

        props.search = `
            earliest=${timeTokens.event_time_earliest}
            latest=${timeTokens.event_time_latest}
            _index_earliest=${timeTokens.index_time_earliest}
            _index_latest=${timeTokens.index_time_latest}
            ${origSearch.properties().search}
        `.trim();

        return props;
    }

    async function trackJob(job) {
        return new Promise((resolve, reject) => {
            job.track({}, {
                done: job => { resolve(job) },
                failed: job => { resolve(job) },
                error: error => { reject(error) },
            })
        }) 
    }

    async function fetchSavedSearches() {
        return new Promise((resolve, reject) => {
            savedSearches.fetch(function(err, resource) {
                if (err) return reject(err);
                resolve(resource);
            });
        }) 
    }

    async function createSavedSearch(properties) {
        return new Promise((resolve, reject) => {
            savedSearches.create(properties, function(err, resource) {
                if (err) return reject(err);
                resolve(resource);
            });
        })
    }

    async function updateSavedSearchACL(savedSearch, acl) {
        return new Promise((resolve, reject) => {
            savedSearch.post('acl', acl, function(err, resource) {
                if (err) return reject(err);
                resolve(resource);
            });
        }) 
    }

    async function dispatchSavedSearch(savedSearch) {
        return new Promise((resolve, reject) => {
            savedSearch.dispatch({trigger_actions: true}, function(err, job) {
                if (err) return reject(err);
                resolve(job);
            });
        }) 
    }

    async function deleteSavedSearch(savedSearch) {
        return new Promise((resolve, reject) => {
            savedSearch.del('', {}, function(err, resource) {
                if (err) return reject(err);
                resolve(resource);
            });
        }) 
    }
});
