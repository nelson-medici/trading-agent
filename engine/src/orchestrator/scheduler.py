"""APScheduler con jobs."""
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
from src.orchestrator import jobs

scheduler = AsyncIOScheduler(timezone="UTC")


def setup_jobs() -> None:
    scheduler.add_job(jobs.heartbeat, IntervalTrigger(minutes=1), id="hb", max_instances=1)
    scheduler.add_job(jobs.ingest_market_data, CronTrigger(minute=5), id="ingest_market", max_instances=1)
    scheduler.add_job(jobs.ingest_news, IntervalTrigger(minutes=30), id="ingest_news", max_instances=1)
    scheduler.add_job(jobs.compute_features_and_score, CronTrigger(minute=15), id="score", max_instances=1)
    scheduler.add_job(jobs.evaluate_decisions, CronTrigger(minute=20), id="decide", max_instances=1)
    scheduler.add_job(jobs.watch_candidates, IntervalTrigger(minutes=15), id="watch_c", max_instances=1)
    scheduler.add_job(jobs.watch_positions, IntervalTrigger(minutes=5), id="watch_p", max_instances=1)
    scheduler.add_job(jobs.reconcile_orders, IntervalTrigger(minutes=5), id="reconcile", max_instances=1)
    scheduler.add_job(jobs.backup_db, CronTrigger(hour=4, minute=0), id="backup")
    scheduler.add_job(jobs.daily_report, CronTrigger(hour=23, minute=55), id="daily")
    scheduler.add_job(jobs.weekly_review, CronTrigger(day_of_week="sun", hour=23, minute=0), id="weekly")
    scheduler.add_job(jobs.rollover_daily_dd, CronTrigger(hour=0, minute=0), id="dd_d")
    scheduler.add_job(jobs.rollover_weekly_dd, CronTrigger(day_of_week="mon", hour=0, minute=0), id="dd_w")
