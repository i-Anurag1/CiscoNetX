from __future__ import annotations
import csv,io,json
from reportlab.lib.pagesizes import A4
from reportlab.platypus import SimpleDocTemplate,Paragraph,Spacer,Table,TableStyle
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet

def csv_runs(runs):
    b=io.StringIO(); w=csv.writer(b); w.writerow(['id','scenario','seed','status','metrics'])
    for r in runs: w.writerow([r.id,r.scenario,r.seed,r.status,json.dumps(r.metrics,separators=(',',':'))])
    return b.getvalue()

def pdf_report(project,runs):
    b=io.BytesIO(); doc=SimpleDocTemplate(b,pagesize=A4,rightMargin=36,leftMargin=36,topMargin=36,bottomMargin=36); s=getSampleStyleSheet(); story=[Paragraph('CiscoNetX Network Engineering Report',s['Title']),Paragraph(f'Project: {project.name}',s['Heading2']),Paragraph(f'Devices: {len(project.topology.get("nodes",[]))} | Links: {len(project.topology.get("links",[]))}',s['BodyText']),Spacer(1,12)]
    rows=[['Run','Scenario','Seed','Status']]+[[str(r.id),r.scenario,str(r.seed),r.status] for r in runs]
    t=Table(rows,repeatRows=1); t.setStyle(TableStyle([('GRID',(0,0),(-1,-1),.4,colors.grey),('BACKGROUND',(0,0),(-1,0),colors.lightgrey)])); story.append(t); doc.build(story); return b.getvalue()
