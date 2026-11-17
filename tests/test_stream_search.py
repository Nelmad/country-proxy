"""Observe the live dispatcher and actual checker calls, not just a credit calculation."""
import asyncio
from collections import Counter, namedtuple
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
from core import Candidate, COUNTRIES
from stream_search import StreamSearch


Batch = namedtuple('Batch', 'group source candidates fetched_at complete error', defaults=(True, None))
def batch(group, items, *, source=None, complete=True):
    return Batch(group, source or group, tuple(items), 1000., complete)
def item(n):
    return Candidate('http', f'8.{n // 65536}.{n // 256 % 256}.{n % 256}', 3128)
def identity(_):
    pass


class StreamingTests(unittest.IsolatedAsyncioTestCase):
    async def test_fast_feed_reaches_checker_and_wins_while_sibling_feed_is_hanging(self):
        hung, cleanup, checked = asyncio.Event(), asyncio.Event(), []
        async def producer(_):
            try:
                yield batch('fast', [item(1)])
                hung.set()
                await asyncio.Future()
            finally:
                cleanup.set()
        async def checker(i, cc, slow):
            checked.append((i, cc, slow))
            await hung.wait()
            return {'country':cc, 'host':i.host}
        s = StreamSearch('NO',['fast','slow'],producer,shuffle=identity,discovery_budget=30)
        result, errors = await asyncio.wait_for(s.run_round(checker), 1)
        self.assertEqual(result['country'], 'NO'); self.assertTrue(cleanup.is_set())
        self.assertFalse(errors); self.assertEqual(checked,[(item(1),'NO', False)])

    async def test_slow_retry_starts_before_discovery_timeout_and_survives_it(self):
        cancelled, entered, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        async def producer(_):
            try:
                yield batch('feed', [item(1)], complete=False)
                await asyncio.Future()
            finally:
                cancelled.set()
        async def check(i, cc, slow):
            if not slow:return None
            self.assertFalse(cancelled.is_set()); entered.set()
            await release.wait();return {'country':cc}
        s=StreamSearch('NO',['feed'],producer,discovery_budget=.12)
        task=asyncio.create_task(s.run_round(check))
        try:
            await asyncio.wait_for(entered.wait(),1)
            await asyncio.wait_for(cancelled.wait(),1)
            self.assertFalse(task.done());release.set()
            result,_=await asyncio.wait_for(task,1)
            self.assertEqual(result,{'country':'NO'})
            self.assertEqual((s.last_stats['fast'],s.last_stats['slow']),(1,1))
        finally:
            release.set();task.cancel();await asyncio.gather(task,return_exceptions=True)

    async def test_late_country_keeps_share_even_under_saturation(self):
        slow_country = asyncio.Event(); full = asyncio.Event(); gate=asyncio.Event()
        probes=[]; calls=Counter(); live=peak=0
        async def source(cc):
            if cc=='NO':await slow_country.wait()
            offset=0 if cc=='EE' else 1000
            yield batch('feed', [item(offset+i+1) for i in range(120)])
        async def check(i, _, slow):
            nonlocal live,peak
            live+=1;peak=max(peak,live); calls[i]+=1
            if not slow:probes.append(i)
            if live==10:full.set()
            try:await gate.wait()
            finally:live-=1
        s=StreamSearch(('NO','EE'),['feed'],source,shuffle=identity)
        task=asyncio.create_task(s.run_round(check))
        try:
            await asyncio.wait_for(full.wait(),2)
            self.assertTrue(all(int(i.host.split('.')[-2])<3 for i in probes))
            slow_country.set();gate.set();await asyncio.wait_for(task,3)
            self.assertEqual(sum(i in {item(k+1) for k in range(120)} for i in probes),60)
            self.assertEqual(len(probes),120);self.assertTrue(all(v==2 for v in calls.values()))
            self.assertEqual(s.last_stats['checks'],240);self.assertEqual(peak,10)
        finally:
            gate.set();slow_country.set();task.cancel();await asyncio.gather(task,return_exceptions=True)

    async def test_late_provider_shares_fairly_with_multiple_mirrors(self):
        release=asyncio.Event(); got_six=asyncio.Event();seen=[]
        async def source(_):
            yield batch('mirrors',[item(i) for i in range(60)],source='mirror-A',complete=False)
            yield batch('mirrors',[item(i) for i in range(60,120)],source='mirror-B')
            await release.wait()
            yield batch('late',[item(i) for i in range(200,320)])
        async def check(i,_,slow):
            if not slow:
                seen.append(i)
                if len(seen)>=6:got_six.set()
        s=StreamSearch('EE',['mirrors','late'],source,shuffle=identity,cap=12)
        task=asyncio.create_task(s.run_round(check))
        try:
            await asyncio.wait_for(got_six.wait(),1)
            for _ in range(5):await asyncio.sleep(0)
            self.assertEqual(len(seen),6)
            release.set();await asyncio.wait_for(task,2)
            self.assertEqual(len(seen),12)
            self.assertEqual(sum(i in {item(k) for k in range(200,320)} for i in seen),6)
        finally:
            release.set();task.cancel();await asyncio.gather(task,return_exceptions=True)

    async def test_unequal_source_speed_does_not_evict_retained_heads(self):
        async def producer(_):
            yield batch('A',[item(i) for i in range(120)],complete=False)
            yield batch('B',[item(i) for i in range(200,320)],complete=False)
        s=StreamSearch('NO',['A','B'],producer,cap=2,shuffle=identity)
        seen=[]
        async def check(i,_,slow):seen.append(i)
        for _ in range(2):
            await s.run_round(check,slow_only=True)
            self.assertLessEqual(sum(len(q) for q in s.pending['NO'].values()),120)
        self.assertEqual(seen,[item(0),item(200),item(1),item(201)])

    async def test_country_probe_bound_real_starts_for_all_sizes_and_input_permutations(self):
        all_cc=sorted(COUNTRIES)
        for n in (1,2,3,120,121,249):
            actual=[]
            for reverse in (False, True):
                selected=all_cc[:n]; index={c:i for i,c in enumerate(selected)}
                async def source(cc):
                    # Enough pending work every round, regardless of cache eviction.
                    yield batch('feed',[item(index[cc]*121+i+1) for i in range(2 if n>=120 else 120)])
                started=[]
                async def check(i,_,slow):
                    self.assertTrue(slow)
                    started.append((s.round_number,i))
                s=StreamSearch(selected[::-1] if reverse else selected,['feed'],source,shuffle=identity)
                rounds=(n+119)//120 + 1
                for _ in range(rounds):
                    await s.run_round(check,slow_only=True)
                    self.assertLessEqual(s.last_stats['admissions'],120)
                    self.assertLessEqual(s.last_stats['peak_checks'],10)
                by_country={}
                for rd,candidate in started:
                    parts=list(map(int,candidate.host.split('.')))
                    ix=(parts[1]*65536 + parts[2]*256 + parts[3]-1)//121
                    by_country.setdefault(selected[ix],rd)
                self.assertEqual(len(by_country),n)
                self.assertLessEqual(max(by_country.values()),rounds)
                actual.append(by_country)
            self.assertEqual(actual[0],actual[1])

    async def test_discovery_cursor_uses_only_actual_starts_and_skips_no_country(self):
        selected=sorted(COUNTRIES)[:10];starts=[];ended=[]
        async def source(cc):
            starts.append(cc)
            try:await asyncio.Future()
            finally:ended.append(cc)
            yield
        async def check(*_):self.fail('no candidates')
        s=StreamSearch(selected,['test'],source,shuffle=identity,discovery_budget=.015)
        for _ in range(4):await s.run_round(check)
        self.assertEqual(starts,selected+selected[:2])
        self.assertEqual(Counter(starts),Counter(ended))

    async def test_duplicate_endpoint_has_one_attempt_with_bounded_provenance(self):
        done=asyncio.Event();calls=0
        async def source(cc):
            yield batch('g1',[item(1)],source='mirror')
            yield batch('g2',[item(1)])
            if cc=='NO':done.set()
        async def check(i,selection,slow):
            nonlocal calls;calls+=1;await done.wait()
            return {'country':'EE'}
        s=StreamSearch(['NO','EE'],['g1','g2'],source,shuffle=identity)
        found,_=await s.run_round(check)
        self.assertEqual(found,{'country':'EE'});self.assertEqual(calls,1)
        self.assertEqual(len(s.last_observations),1)
        obs=s.last_observations[0]
        self.assertEqual(obs['nativeQualified'],True);self.assertIsNone(obs['browserConfirmed'])
        self.assertEqual({v['group'] for v in obs['sources']},{'g1','g2'})
        self.assertTrue(all(v['updatedAt'] is None for v in obs['sources']))

    async def test_stop_twice_drains_both_checker_and_async_generator_cleanups(self):
        probe=asyncio.Event();gen=asyncio.Event();probe_cleanup=asyncio.Event()
        gen_cleanup=asyncio.Event();release=asyncio.Event();finished=[]
        async def source(_):
            try:
                yield batch('feed',[item(1)],complete=False)
                gen.set();await asyncio.Future()
            finally:
                gen_cleanup.set();await release.wait();finished.append('generator')
        async def check(*_):
            try:probe.set();await asyncio.Future()
            finally:probe_cleanup.set();await release.wait();finished.append('checker')
        s=StreamSearch('NO',['feed'],source)
        task=asyncio.create_task(s.run_round(check))
        try:
            await asyncio.wait_for(asyncio.gather(probe.wait(),gen.wait()),1);task.cancel()
            await asyncio.wait_for(asyncio.gather(probe_cleanup.wait(),gen_cleanup.wait()),1)
            task.cancel();await asyncio.sleep(0);self.assertFalse(task.done())
            release.set()
            with self.assertRaises(asyncio.CancelledError):await asyncio.wait_for(task,1)
            self.assertCountEqual(finished,['generator','checker'])
            self.assertEqual(s.last_observations[0]['stage'],'cancelled')
            self.assertIn(item(1).key,s.records)
        finally:
            release.set();task.cancel();await asyncio.gather(task,return_exceptions=True)

    async def test_refill_accepts_multiple_distinct_results_then_stops(self):
        finished=[];accepted=[]
        async def source(_):
            try:
                yield batch('f',[item(i) for i in range(9)],complete=False)
                await asyncio.Future()
            finally:finished.append('closed')
        async def check(i,_,slow):
            self.assertTrue(slow)
            return {'host':i.host,'country':'EE'}
        def accept(value):
            accepted.append(value['host']);return len(accepted)==2
        s=StreamSearch('EE',['f'],source)
        await s.run_round(check,on_result=accept,slow_only=True,concurrency=3)
        self.assertEqual(len(set(accepted)),2);self.assertEqual(finished,['closed'])
        self.assertLessEqual(s.last_stats['peak_checks'],3)

    async def test_no_permanent_skip_when_checker_independently_cancels(self):
        async def source(_):yield batch('one',[item(1)])
        async def check(*_):raise asyncio.CancelledError
        s=StreamSearch('EE',['one'],source)
        self.assertEqual(await asyncio.wait_for(s.run_round(check),1),(None,[]))
        self.assertIn(item(1).key,s.records)
        self.assertEqual(s.last_observations[0]['stage'],'cancelled')

    async def test_late_retained_ready_endpoint_reaches_exact_country_bound(self):
        for n in (1,2,3,120,121,249):
            with self.subTest(n=n):
                countries=sorted(COUNTRIES)[:n]; chosen=min(n,120)-1
                target=countries[chosen]
                share=120//n + int(chosen < 120%n)
                indexes={cc:i for i,cc in enumerate(countries)}
                late=item(2_000_000)
                initial=set(item(chosen*121+i) for i in range(share))
                spent=asyncio.Event();actual=[]
                async def source(cc):
                    if cc==target:
                        if s.round_number==1:
                            yield batch('g',sorted(initial,key=lambda x:x.key),complete=False)
                            await spent.wait()
                            yield batch('g',[late])
                    else:
                        # No unused credit can accidentally mask a lost cursor turn.
                        count=min(120,120//n+2)
                        yield batch('g',[item(s.round_number*40000+indexes[cc]*121+i)
                                         for i in range(count)])
                async def check(i,cc,slow):
                    if i in initial:
                        initial.remove(i)
                        if not initial:spent.set()
                    if i==late:actual.append(s.round_number)
                s=StreamSearch(countries,['g'],source,shuffle=identity)
                for _ in range(1+(n+119)//120):
                    await asyncio.wait_for(s.run_round(check,slow_only=True),3)
                self.assertEqual(actual,[1+(n+119)//120])

    async def test_provider_credit_cursor_persists_when_country_gets_one_ticket(self):
        async def source(_):
            yield batch('A',[item(i) for i in range(120)])
            yield batch('B',[item(i+400) for i in range(120)])
        started=[]
        async def check(i,*_):started.append(i)
        s=StreamSearch('EE',['A','B'],source,cap=1,shuffle=identity)
        for _ in range(10):await s.run_round(check,slow_only=True)
        self.assertEqual(started,[item(i+offset) for i in range(5) for offset in (0,400)])

    async def test_renaming_iso_preserves_dispatch_with_coupled_ring(self):
        async def run(names):
            ring=list(names)
            async def source(cc):
                yield batch('f',[item(names.index(cc)*100+i) for i in range(20)])
            async def check(i,cc,slow):trace.append(i)
            def fixed(order):
                if set(order)==set(ring):order[:]=ring
            trace=[]
            s=StreamSearch(ring[::-1],['f'],source,cap=17,shuffle=fixed)
            for _ in range(3):await s.run_round(check,slow_only=True)
            return trace
        self.assertEqual(await run(['EE','PL','NO']),await run(['DE','JP','AU']))

    async def test_unstarted_refill_work_precedes_cancelled_slow_probes(self):
        saturated=asyncio.Event(); starts=[]
        async def source(_):yield batch('f',[item(i) for i in range(6)])
        async def blocked(i,_,slow):
            starts.append(i)
            if len(starts)==3:saturated.set()
            await asyncio.Future()
        s=StreamSearch('NO',['f'],source)
        run=asyncio.create_task(s.run_round(blocked,slow_only=True,concurrency=3))
        try:await asyncio.wait_for(saturated.wait(),1)
        finally:run.cancel();await asyncio.gather(run,return_exceptions=True)
        after=[]
        async def check(i,_,slow):after.append(i)
        await s.run_round(check,slow_only=True,concurrency=3)
        self.assertEqual(after[:3],[item(3),item(4),item(5)])

    async def test_reoffer_after_terminal_check_is_ready_next_round_without_refetch(self):
        physical=[];terminal=asyncio.Event()
        async def source(cc):
            if s.round_number==1:
                if cc=='NO':
                    await terminal.wait()
                    # The trace is not merely concurrent with the first call:
                    # NO is observed only after EE's terminal response.
                    await asyncio.sleep(0)
                yield batch('feed',[item(1)])
        async def check(i,_,slow):
            physical.append((s.round_number,slow))
            if slow:terminal.set()
        s=StreamSearch(['EE','NO'],['feed'],source,shuffle=identity)
        await s.run_round(check)
        self.assertEqual(physical,[(1,False),(1,True)])
        self.assertIn(item(1).key,s.pending['NO']['feed'])
        await s.run_round(check)
        self.assertEqual(physical,[(1,False),(1,True),(2,False),(2,True)])
        self.assertEqual(s.last_observations[0]['requestedCountry'],'NO')
        s.clear_pending();self.assertFalse(s.records)

    async def test_deferred_head_neither_blocks_sibling_nor_hoards_country_donation(self):
        # cap=4 -> 2 EE / 2 NO. NO later offers X (already checked for EE)
        # then a new Y: Y runs this round, and one spare NO credit serves EE/Z.
        checked=asyncio.Event();calls=[]
        async def source(cc):
            if s.round_number==1:
                if cc=='EE':
                    yield batch('feed',[item(1),item(2),item(3)])
                else:
                    await checked.wait()
                    yield batch('feed',[item(1),item(4)])
        async def check(i,_,slow):
            calls.append((s.round_number,i))
            if i==item(1):checked.set()
        s=StreamSearch(['EE','NO'],['feed'],source,shuffle=identity,cap=4)
        await s.run_round(check,slow_only=True)
        self.assertCountEqual([i for n,i in calls if n==1],[item(i) for i in (1,2,3,4)])
        self.assertEqual(list(s.pending['NO']['feed']),[item(1).key])
        await s.run_round(check,slow_only=True)
        self.assertEqual([i for n,i in calls if n==2],[item(1)])

    async def test_duplicate_readiness_counts_against_country_cap_during_round(self):
        all_started=asyncio.Event();counts=[];physical=[]
        old=[item(i) for i in range(120)]
        async def source(cc):
            yield batch('g',old,complete=False)
            await all_started.wait()
            yield batch('g',old,complete=False)
            counts.append(sum(map(len,s.pending[cc].values())))
            yield batch('g',[item(i+200) for i in range(120)])
            counts.append(sum(map(len,s.pending[cc].values())))
        async def check(i,*_):
            physical.append(i)
            if len(physical)==120:all_started.set()
        s=StreamSearch('NO',['g'],source,shuffle=identity)
        await asyncio.wait_for(s.run_round(check,slow_only=True),2)
        self.assertEqual(physical,old);self.assertEqual(counts,[120,120])
        self.assertEqual(list(s.pending['NO']['g']),[i.key for i in old])
        self.assertEqual(len(s.records),120)
