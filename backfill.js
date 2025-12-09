require([
    'underscore',
    'jquery',
    'splunkjs/mvc',
    'splunkjs/mvc/searchmanager',
    'splunkjs/mvc/simplexml/ready!'
], function (_, $, mvc, SearchManager) {

    const validSearchPropsRegex = /^(?:action\.[^.]+|action\.[^.]+\.[^.]+|action\.summary_index\._type|action\.summary_index\.force_realtime_schedule|actions|alert\.digest_mode|alert\.expires|alert\.severity|alert\.suppress|alert\.suppress\.fields|alert\.suppress\.group_name|alert\.suppress\.period|alert\.track|alert_comparator|alert_condition|alert_threshold|alert_type|allow_skew|args\.[^.]+|auto_summarize|auto_summarize\.command|auto_summarize\.cron_schedule|auto_summarize\.dispatch\.[^.]+|auto_summarize\.max_concurrent|auto_summarize\.max_disabled_buckets|auto_summarize\.max_summary_ratio|auto_summarize\.max_summary_size|auto_summarize\.max_time|auto_summarize\.suspend_period|auto_summarize\.timespan|cron_schedule|description|disabled|dispatch\.[^.]+|dispatchAs|displayview|durable\.[^.]+|is_scheduled|is_visible|max_concurrent|name|next_scheduled_time|qualifiedSearch|realtime_schedule|request\.ui_dispatch_(?:app|view)|restart_on_searchpeer_add|run_n_times|run_on_startup|schedule_priority|schedule_window|search|vsid|workload_pool)$/;
    const service = mvc.createService({'owner': 'admin', 'app': 'search'});
    const tokens = mvc.Components.get("default", { create: true });
    const savedSearches = service.savedSearches();

    $('.btn-select-all').click(function() {
        $('#pri_checkboxes div[data-test="switch"]').each(function() {
            if ($(this).attr('data-test-selected') == 'false') {
                $('button', this).click()
            }
        })
    })

    $('.btn-deselect-all').click(function() {
        $('#pri_checkboxes div[data-test="switch"]').each(function() {
            if ($(this).attr('data-test-selected') == 'true') {
                $('button', this).click()
            }
        })
    })

    $('.btn-create-backfill-searches').click(async function() {
        const $btn = $(this);

        if ($btn.hasClass('disabled')) return; // prevent double-click
        $btn.addClass('disabled');
        $('#pri_checkboxes button').prop('disabled', true);

        const event_time_earliest = tokens.get('event_time.earliest');
        const event_time_latest = tokens.get('event_time.latest');
        const index_time_earliest = tokens.get('index_time.earliest');
        const index_time_latest = tokens.get('index_time.latest');

        const checkedSearches = $('#pri_checkboxes div[data-test-selected="true"]').map(function() {
            return $(this).attr('data-test-value');
        }).get();

        try {
            const fetchedSearches = await fetchSavedSearches();
 
            checkedSearches.forEach(async function(search_name, index) {
                
                const $current = $(`#pri_checkboxes div[data-test-value="${search_name}"]`);
                $('.status-message', $current).remove();

                const $status_message = $('<div class="status-message"></div>').appendTo($current);

                setStatus($status_message, 'Cloning backfill search...', 'in-progress')

                let sid;
                                
                try {
                    if (!fetchedSearches) {
                        setStatus($status_message, 'Unable to load saved searches', 'error');
                        return;
                    }
                    
                    let search = fetchedSearches.item(search_name);
                    let properties = search.properties();

                    const new_properties = {};
    
                    for (const [key, value] of Object.entries(properties)) {
                        if (validSearchPropsRegex.test(key)) {
                            new_properties[key] = value;
                        }
                    }

                    backfill_title = search_name + ' - Backfill';
                    new_properties.is_scheduled = 0;
                    new_properties.name = backfill_title;
                    new_properties.search = `earliest=${event_time_earliest} latest=${event_time_latest} _index_earliest=${index_time_earliest} _index_latest=${index_time_latest} ${properties.search}`

                    let savedSearch;

                    try {
                        savedSearch = await createSavedSearch(new_properties);
                    } catch (createError) {
                        error_message = createError.data.messages[0].text;
                        setStatus($status_message, error_message, 'error');
                        return
                    }

                    setStatus($status_message, 'Updating scope and owner...', 'in-progress')

                    try {
                        await updateSavedSearchACL(savedSearch, {
                            'sharing': 'global',
                            'owner': 'admin'
                        });

                    } catch (updateError) {
                        console.log(updateError);
                        setStatus($status_message, `Search created but unable to update to the global scope. Does the search already exist?`, 'error');
                        return
                    }

                    setStatus($status_message, 'Dispatching...', 'in-progress')

                    try {
                        const job = await dispatchSavedSearch(savedSearch);
                        await trackJob(job);

                        const job_properties = job.properties();
                        console.log(job_properties);
                        sid = job_properties.sid;
                        if (job_properties.dispatchState == 'FAILED') {
                            setStatus($status_message, `Search dispatched but failed. View the <a target="_blank" href="/app/search/job_manager?filter=${sid}">search job</a> for details`, 'error');
                            return;
                        }

                    } catch (dispatchError) {
                        setStatus($status_message, `Search created but unable to dispatch: ${dispatchError}`, 'error');
                        return
                    }

                    setStatus($status_message, 'Deleting backfill search...', 'in-progress')

                    try {
                        await deleteSavedSearch(savedSearch);
                    } catch (deleteError) {
                        setStatus($status_message, `Search dispatched, but unable to delete: ${deleteError}`, 'error');
                        return
                    }

                } catch (innerError) {
                    console.log(innerError)
                    setStatus($status_message, innerError.toString(), 'error');
                    return
                }
                setStatus($status_message, `Complete. View the <a target="_blank" href="/app/search/job_manager?filter=${sid}">search job</a> for details`, 'done');
            });            
        } catch (error) {
            console.error('Error fetching saved searches or creating backfill:' + error.toString());
        }

        $btn.removeClass('disabled');
        $('#pri_checkboxes button').prop('disabled', false);
    });

    function setStatus($el, message, status) {
        $el.html(message);
        $el.removeClass('error in-progress done').addClass(status)
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
            savedSearch.dispatch({trigger_actions: true}, function(err, job, savedSearch) {
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
