"""Build an org-1-only review dashboard from the authoritative private SQL source.

Never deploy this artifact to org 2 or replace the live UID without acceptance.
"""
import copy
import json
from pathlib import Path

HERE = Path(__file__).parent
source = json.loads((HERE / 'dashboard.json').read_text())
UID = 'powershell-mcp-pg'

def panel(id, title, typ, x, y, w, h, sql, *, description='', options=None, unit=None):
    p = {'id': id, 'title': title, 'type': typ, 'gridPos': {'x': x, 'y': y, 'w': w, 'h': h},
         'datasource': {'type': 'postgres', 'uid': UID}, 'description': description,
         'targets': [{'refId': 'A', 'format': 'table',
                      'rawQuery': True, 'rawSql': sql, 'datasource': {'type': 'postgres', 'uid': UID}}]}
    if typ == 'stat':
        p['targets'][0]['format'] = 'table'
        p['options'] = {'reduceOptions': {'calcs': ['lastNotNull'], 'fields': '', 'values': False},
                        'orientation': 'horizontal', 'textMode': 'value_and_name', 'colorMode': 'none', 'graphMode': 'none'}
    if options: p['options'] = options
    if unit: p['fieldConfig'] = {'defaults': {'unit': unit}, 'overrides': []}
    return p

window = 'WHERE $__timeFilter(event_at)'
outcomes = "axis = 'outcomes'"
durations = "axis = 'durations'"
not_success = "bucket IN ('nonzero','error','timeout','cancelled','unknown')"
metric = 'dashboard_metric_axes'
P = [
 panel(101,'Recorded calls','stat',0,0,6,4,f"SELECT sum(calls) AS calls FROM {metric} {window} AND {outcomes}",description='Metric-instrumented calls in selected event-time window. Legacy count batches are excluded; not a total of every historical call.'),
 panel(102,'Non-success','stat',6,0,6,4,f"SELECT sum(calls) FILTER (WHERE {not_success}) AS outcomes FROM {metric} {window} AND {outcomes}",description='Includes nonzero exits, errors, timeouts, cancellations and unknown outcomes. A nonzero exit is not necessarily a product defect.'),
 panel(103,'Calls ≥10 seconds','stat',12,0,6,4,f"SELECT sum(calls) FILTER (WHERE bucket = 'gte10000') AS slow_calls FROM {metric} {window} AND {durations}",description='Recorded duration bucket, not an inferred p95 or execution-time percentile.'),
 panel(104,'Data receipt','stat',18,0,6,4,"SELECT (extract(epoch FROM max(received_at))*1000)::bigint AS last_receipt FROM dashboard_events WHERE received_at <= $__timeTo()::timestamptz",description='Latest received telemetry at or before the window end. Receipt is not end-to-end delivery or instrumentation proof.',unit='dateTimeAsIso'),
 {'id':105,'title':'How to read this overview','type':'text','gridPos':{'x':0,'y':4,'w':24,'h':6},'options':{'mode':'markdown','content':'### What needs attention?\nStart with **Tools to review**, ordered by recorded non-success count, then slow calls. Percentages apply **only to metric-recorded calls**. Nonzero exits may be expected; inspect the workload before diagnosing a defect. **Data receipt** means arrival, not complete coverage. Legacy counts are **not added**; missing metric rows mean *unknown*, not zero. Open **Data and delivery details** for coverage and audit context.'}},
]
ranked = """WITH outcomes AS (
 SELECT tool,sum(calls) AS recorded_calls,
 sum(calls) FILTER (WHERE bucket IN ('nonzero','error','timeout','cancelled','unknown')) AS non_success,
 sum(calls) FILTER (WHERE bucket = 'timeout') AS timeouts,
 sum(calls) FILTER (WHERE bucket = 'error') AS errors,
 sum(calls) FILTER (WHERE bucket = 'nonzero') AS nonzero_exits,
 sum(calls) FILTER (WHERE bucket = 'cancelled') AS cancelled,
 sum(calls) FILTER (WHERE bucket = 'unknown') AS unknown_outcomes
 FROM dashboard_metric_axes WHERE $__timeFilter(event_at) AND axis = 'outcomes' GROUP BY tool
), durations AS (
 SELECT tool,sum(calls) AS duration_recorded_calls,
 sum(calls) FILTER (WHERE bucket = 'gte10000') AS slow_calls
 FROM dashboard_metric_axes WHERE $__timeFilter(event_at) AND axis = 'durations' GROUP BY tool
)
SELECT coalesce(o.tool,d.tool) AS tool, o.recorded_calls,
 coalesce(o.non_success,0) AS non_success,
 round(100.0*coalesce(o.non_success,0)/NULLIF(o.recorded_calls,0),1) AS non_success_pct,
 coalesce(o.timeouts,0) AS timeouts,
 d.slow_calls AS slow_calls,
 round(100.0*d.slow_calls/NULLIF(d.duration_recorded_calls,0),1) AS slow_pct
FROM outcomes o FULL OUTER JOIN durations d ON o.tool=d.tool
ORDER BY non_success DESC NULLS LAST, slow_calls DESC NULLS LAST, tool"""
P.append(panel(106,'Tools to review','table',0,10,24,7,ranked,description='Metric stream only. Non-success includes nonzero, errors, timeout, cancelled and unknown; slow is ≥10 seconds. Independent outcome/duration marginals aggregated before joining by tool. A missing axis is unknown.'))
P[-1]['fieldConfig']={'defaults':{},'overrides':[{'matcher':{'id':'byName','options':name},'properties':[{'id':'custom.width','value':width}]} for name,width in [('tool',185),('recorded_calls',130),('non_success',130),('non_success_pct',150),('timeouts',100),('slow_calls',115),('slow_pct',115)]]}
P.append(panel(107,'Recorded outcomes by tool','barchart',0,17,12,8,"SELECT tool, sum(calls) FILTER (WHERE bucket = 'success') AS success, sum(calls) FILTER (WHERE bucket = 'nonzero') AS nonzero, sum(calls) FILTER (WHERE bucket = 'error') AS errors, sum(calls) FILTER (WHERE bucket = 'timeout') AS timeouts, sum(calls) FILTER (WHERE bucket = 'cancelled') AS cancelled, sum(calls) FILTER (WHERE bucket = 'unknown') AS unknown FROM dashboard_metric_axes WHERE $__timeFilter(event_at) AND axis = 'outcomes' GROUP BY tool ORDER BY tool",description='Distinct outcomes; a nonzero exit alone does not establish a defect.',options={'orientation':'horizontal','xField':'tool','stacking':'normal','showValue':'never','legend':{'displayMode':'list','placement':'bottom'}}))
P.append(panel(108,'Recorded calls by tool','barchart',12,17,12,8,"SELECT tool, sum(calls) AS calls FROM dashboard_metric_axes WHERE $__timeFilter(event_at) AND axis = 'outcomes' GROUP BY tool ORDER BY calls DESC",description='One metric stream only. Legacy counts are separately available below.',options={'orientation':'horizontal','xField':'tool','showValue':'auto','legend':{'showLegend':False}}))
row={'id':109,'title':'Data and delivery details','type':'row','gridPos':{'x':0,'y':25,'w':24,'h':1},'collapsed':True,'panels':[]}
for old in source['panels']:
    old=copy.deepcopy(old)
    old['id'] += 200
    old['datasource']['uid']=UID
    for target in old.get('targets',[]): target['datasource']={'type':'postgres','uid':UID}
    row['panels'].append(old)
P.append(row)
preview={'uid':'powershell-mcp-overview-preview','title':'PowerShell MCP — Overview (PREVIEW)',
         'schemaVersion':source['schemaVersion'],'version':0,'time':{'from':'now-24h','to':'now'},
         'refresh':'5m','timezone':'utc','panels':P,'tags':['PowerShell MCP','preview','usage','reliability']}
(HERE/'overview-preview.json').write_text(json.dumps(preview,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
