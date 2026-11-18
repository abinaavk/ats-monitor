"""Large job log and inconsistent process-result regressions."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import manage_api

class ManageRegressions(unittest.TestCase):
    def test_terminal_result_survives_large_log(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'log.ndjson'
            line=json.dumps({'t':'log','m':'x'*1000})+'\n'
            result={'t':'result','ok':True,'data':{'done':True}}
            p.write_text(line*(manage_api.MAX_LOG_BYTES//len(line)+20)+json.dumps(result)+'\n')
            with patch.object(manage_api,'_job_path',return_value=str(p)),patch.object(manage_api,'_proc_state',return_value=False),patch.object(manage_api,'_write_json'),patch.object(manage_api,'_reap_children'):
                events=manage_api._read_log('test')
                self.assertEqual(manage_api._final_result(events),result)
                updated=manage_api._refresh({'id':'test','status':'running','pid':123,'ticks':1})
                self.assertEqual(updated['status'],'done')
                self.assertLess(len(events),5000)
    def test_nonzero_exit_cannot_report_success(self):
        r=subprocess.CompletedProcess(['ats'],7,json.dumps({'t':'result','ok':True,'data':{}})+'\n','worker failed')
        with patch.object(manage_api,'ats_command',return_value=('ats',['ats'])),patch.object(manage_api.subprocess,'run',return_value=r):
            with self.assertRaises(manage_api.ApiError):manage_api.ats_call('services.list')
if __name__=='__main__':unittest.main()
