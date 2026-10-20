from app.enterprise import assistant_tutor


def test_tutor_rip_returns_executable_lab_plan():
    result = assistant_tutor({'question': 'Configure RIP between two routers and verify convergence after a link failure'})
    assert result['grounded'] is True
    assert 'RIP / Distance Vector' in result['topics']
    assert result['steps']
    assert result['commands']
    assert len(result['topology']['nodes']) == 4


def test_tutor_rejects_empty_question():
    try:
        assistant_tutor({'question': '   '})
    except Exception as exc:
        assert getattr(exc, 'status_code', None) == 422
    else:
        raise AssertionError('Expected HTTPException')
