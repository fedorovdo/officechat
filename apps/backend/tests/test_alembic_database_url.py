import unittest

from alembic.config import Config

from app.db.database_url import (
    normalize_async_postgresql_url,
    prepare_alembic_database_url,
)


class AlembicDatabaseUrlTests(unittest.TestCase):
    def assert_config_round_trip(self, database_url: str, expected_url: str) -> None:
        config = Config()
        config.set_main_option("sqlalchemy.url", prepare_alembic_database_url(database_url))
        self.assertEqual(config.get_main_option("sqlalchemy.url"), expected_url)

    def test_plain_postgresql_url(self):
        database_url = "postgresql://officechat:plain-password@postgres:5432/officechat"
        expected = "postgresql+asyncpg://officechat:plain-password@postgres:5432/officechat"

        self.assertEqual(normalize_async_postgresql_url(database_url), expected)
        self.assert_config_round_trip(database_url, expected)

    def test_percent_encoded_slash_survives_config_parser(self):
        database_url = "postgresql://officechat:test%2Fpassword@postgres:5432/officechat"
        expected = "postgresql+asyncpg://officechat:test%2Fpassword@postgres:5432/officechat"

        self.assert_config_round_trip(database_url, expected)

    def test_multiple_percent_encoded_values_survive_config_parser(self):
        database_url = (
            "postgresql://officechat:test%25value%40host%3Aport@postgres:5432/officechat"
        )
        expected = (
            "postgresql+asyncpg://officechat:test%25value%40host%3Aport@postgres:5432/officechat"
        )

        self.assert_config_round_trip(database_url, expected)

    def test_asyncpg_driver_is_not_added_twice(self):
        database_url = (
            "postgresql+asyncpg://officechat:test%2Fpassword@postgres:5432/officechat"
        )

        self.assertEqual(normalize_async_postgresql_url(database_url), database_url)
        self.assert_config_round_trip(database_url, database_url)

    def test_only_url_scheme_is_normalized(self):
        database_url = (
            "postgresql://officechat:postgresql%3A%2F%2Fsecret@postgres:5432/officechat"
        )
        expected = (
            "postgresql+asyncpg://officechat:postgresql%3A%2F%2Fsecret@postgres:5432/officechat"
        )

        self.assert_config_round_trip(database_url, expected)


if __name__ == "__main__":
    unittest.main()
