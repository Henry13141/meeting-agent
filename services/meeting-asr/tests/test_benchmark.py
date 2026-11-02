from meeting_asr.benchmark import edit_distance, normalized


def test_cer_counts_substitutions_insertions_and_deletions():
    assert edit_distance("会议开始", "会议开始") == 0
    assert edit_distance("会议开始", "会议开时") == 1
    assert edit_distance("会议开始", "会议现在开始") == 2
    assert edit_distance("会议开始", "会议") == 2
    assert normalized("会议，ＡＳＲ 2.0。") == "会议asr20"
