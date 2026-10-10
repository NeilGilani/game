from synapse_mesh.behavior import check_consent


def test_real_consent_behavior():
    text = "```python\ndef validate(record):\n    return bool(record.get('signed_at') and not record.get('withdrawn_at') and record.get('purpose'))\n```"
    assert check_consent(text)['passed'] == 4
    broken = "```python\ndef validate(record):\n    return True\n```"
    assert check_consent(broken)['passed'] == 1


def test_arbitrary_generated_code_cannot_execute():
    for code in ["import os\n    os.system('touch /tmp/bad')", "while True:\n        pass", "return record.__class__", "return open('/tmp/bad','w')"]:
        assert check_consent(f"```python\ndef validate(record):\n    {code}\n``` ")['status'] == 'unverified'
