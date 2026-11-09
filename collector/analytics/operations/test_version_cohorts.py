import copy
from decimal import Decimal
import unittest

import test_weekly_digest as original
from test_weekly_digest import NOW, START, END, trend_fixture, w


def joint_fixture():
    data = trend_fixture()
    for period in (data['previous'],data):
        total = period['tools'][0][-1]
        period['version_outcomes'] = [('unknown_origin','0.8.0','metrics','ssh_exec','calls','total',total),
            ('unknown_origin','0.7.9','counts','ssh_exec','calls','total',1000)] + [
            (o,'0.8.0','metrics',t,a,b,n) for o,t,a,b,n in period['axes']]
    return data


class VersionCohortTests(unittest.TestCase):
    mime_bodies = original.DigestTests.mime_bodies

    def test_partial_current_outcomes_do_not_rank_or_supply_rates(self):
        data=joint_fixture()
        data['axes']=[(o,t,a,b,n-20 if b=='success' else n) for o,t,a,b,n in data['axes']]
        data['version_outcomes']=[(o,v,s,t,a,b,n-20 if (a,b)==('outcomes','success') else n)
                                  for o,v,s,t,a,b,n in data['version_outcomes']]
        for body in self.mime_bodies(data):
            for value in ('380/400 current','partial or missing outcome instrumentation','Outcome coverage: 0/1','Outcomes unavailable'):
                self.assertIn(value,body)
            self.assertNotIn('Largest error volume',body)
            self.assertNotIn('Highest error rate',body)
            self.assertNotIn('Error and timeout comparison',body)

    def test_missing_joint_results_refuse_without_marginal_inference(self):
        for mode in ('withheld','absent_version','unknown_version','zero'):
            data = joint_fixture()
            previous=data['previous']
            if mode=='withheld': previous['version_outcomes']=[]
            elif mode=='absent_version':
                previous['version_outcomes']=[r for r in previous['version_outcomes'] if r[2]=='counts']
                previous['tools']=[r for r in previous['tools'] if r[1]=='counts']
                previous['axes']=[]
            elif mode=='unknown_version': previous['version_outcomes']=[(o,'other',s,t,a,b,n) if s=='metrics' else (o,v,s,t,a,b,n) for o,v,s,t,a,b,n in previous['version_outcomes']]
            else:
                previous['tools'][0]=('unknown_origin','metrics','ssh_exec',0)
                previous['axes']=[]
                previous['version_outcomes']=[(o,v,s,t,a,b,0) if s=='metrics' else (o,v,s,t,a,b,n) for o,v,s,t,a,b,n in previous['version_outcomes'] if a=='calls']
            for body in self.mime_bodies(data):
                self.assertNotIn('Error and timeout comparison',body)
                self.assertIn('refused',body)
                self.assertNotIn('0/0',body)
                if mode=='withheld': self.assertIn('joint version/tool/outcome aggregate unavailable or withheld',body)

    def test_invalid_joint_counts_dimensions_duplicates_and_totals_fail_closed(self):
        base=joint_fixture()
        bad_rows=[('PRIVATE','0.8.0','metrics','ssh_exec','calls','total',200),
                  ('unknown_origin','PRIVATE','metrics','ssh_exec','calls','total',200),
                  ('unknown_origin','0.8.0','counts','ssh_exec','outcomes','error',200),
                  ('unknown_origin','0.8.0','metrics','PRIVATE','calls','total',200),
                  ('unknown_origin','0.8.0','metrics','ssh_exec','outcomes','PRIVATE',200)]
        bad_rows += [('unknown_origin','0.8.0','metrics','ssh_exec','calls','total',n)
                     for n in (True,-1,'200',Decimal('NaN'),Decimal('Infinity'),Decimal('1.5'))]
        for row in bad_rows:
            data=copy.deepcopy(base)
            data['previous']['version_outcomes'].append(row)
            with self.subTest(row=row), self.assertRaises(ValueError): self.mime_bodies(data)
        for mode in ('duplicate','overcoverage','wrong_rollup','orphan'):
            data=copy.deepcopy(base)
            rows=data['previous']['version_outcomes']
            if mode=='duplicate': rows.append(rows[0])
            elif mode=='overcoverage': rows.append(('unknown_origin','0.8.0','metrics','ssh_exec','outcomes','unknown',1000))
            elif mode=='wrong_rollup': rows[0]=rows[0][:-1]+(400,)
            else: rows[:]=[r for r in rows if r[4]!='calls']
            with self.subTest(mode=mode), self.assertRaises(ValueError): self.mime_bodies(data)

    def test_private_permission_does_not_bypass_joint_endpoint_guard(self):
        audience=dict(sender='fixture@example.invalid',recipient=w.RECIPIENT,approved_recipients=[w.RECIPIENT])
        cfg=dict(enabled=True,host='mail.ialogics.co.uk',port=587,username='fixture',**audience,private_small_counts=audience.copy())
        for private in (None,cfg):
            data=joint_fixture()
            # Cross-version cells change by +1/-1 while the old marginal is unchanged.
            for period in (data['previous'],data):
                rows=period['version_outcomes']
                rows[:]=[r for r in rows if r[2]=='counts']
                for v,n in (('0.8.0',100),('0.8.1',100 if period is data['previous'] else 300)):
                    rows.extend([('unknown_origin',v,'metrics','ssh_exec','calls','total',n),
                                 ('unknown_origin',v,'metrics','ssh_exec','outcomes','error',20 if period is data['previous'] else (21 if v=='0.8.0' else 19)),
                                 ('unknown_origin',v,'metrics','ssh_exec','outcomes','timeout',10 if period is data['previous'] else (10 if v=='0.8.0' else 30)),
                                 ('unknown_origin',v,'metrics','ssh_exec','outcomes','success',n-(20 if period is data['previous'] else (21 if v=='0.8.0' else 19))-(10 if period is data['previous'] else (10 if v=='0.8.0' else 30)))])
            for body in self.mime_bodies(data,private):
                self.assertIn('Comparison and numeric details withheld',body)
                self.assertNotIn('<table',body)


if __name__=='__main__': unittest.main()
