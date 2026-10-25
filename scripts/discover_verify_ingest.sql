-- Always ends in an exception so everything rolls back; read the RESULT in the error text.
-- Expected: first accepted=1, dup duplicates=1, batch accepted=2 rejected=2,
--           stats imp=1 opens=1, exposure seen=2 open=1, feed_exposure seen unchanged.
do $$
declare v bigint; p bigint; eid uuid := gen_random_uuid();
        r1 jsonb; r2 jsonb; r3 jsonb; st record; ex record; fx_before int; fx_after int;
begin
  select u.id into v from users u where u.is_active and u.deleted_at is null and u.institution_id is not null order by u.id limit 1;
  select c.post_id into p from public.discover_candidate_pool(v, 't', 'for_you') c where c.kind = 'post' limit 1;
  if p is null then raise exception 'NO CANDIDATE for viewer %', v; end if;
  fx_before := coalesce((select seen_count from feed_exposures where user_id = v and post_id = p), -1);

  r1 := discover_ingest_events(v, jsonb_build_array(jsonb_build_object('event_id', eid, 'kind', 'impression', 'post_id', p, 'src', 'campus', 'slot', 3)));
  r2 := discover_ingest_events(v, jsonb_build_array(jsonb_build_object('event_id', eid, 'kind', 'impression', 'post_id', p)));
  r3 := discover_ingest_events(v, jsonb_build_array(
    jsonb_build_object('event_id', gen_random_uuid(), 'kind', 'impression', 'post_id', p),
    jsonb_build_object('event_id', gen_random_uuid(), 'kind', 'open', 'post_id', p),
    jsonb_build_object('event_id', gen_random_uuid(), 'kind', 'open', 'post_id', -5),
    jsonb_build_object('event_id', gen_random_uuid(), 'kind', 'consume', 'post_id', p)));

  select * into st from discover_post_stats where post_id = p;
  select x.seen_count, x.open_count into ex from discover_exposures x where x.user_id = v and x.post_id = p;
  fx_after := coalesce((select seen_count from feed_exposures where user_id = v and post_id = p), -1);

  raise exception 'RESULT viewer=% post=% first=% dup=% batch=% stats(imp=%,opens=%) exposure(seen=%,open=%) feed_seen_before=% after=%',
    v, p, r1, r2, r3, st.impressions, st.opens, ex.seen_count, ex.open_count, fx_before, fx_after;
end $$;
