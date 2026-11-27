from src.scoring.state_machine import transition


THRESHOLDS = {"ignore_below": 60, "watchlist": 60, "candidate": 75, "aggressive": 85}


def test_low_score_ignore():
    assert transition("IGNORE", 45, THRESHOLDS, False) == "IGNORE"


def test_score_65_watchlist():
    assert transition("IGNORE", 65, THRESHOLDS, False) == "WATCHLIST"


def test_score_80_candidate():
    assert transition("WATCHLIST", 80, THRESHOLDS, False) == "CANDIDATE"


def test_open_position_drops_below_ignore_exits():
    assert transition("ENTERED", 55, THRESHOLDS, True) == "EXIT"


def test_open_position_stays_entered():
    assert transition("ENTERED", 70, THRESHOLDS, True) == "ENTERED"
