"""CiscoNetX initial schema"""
from alembic import op
from sqlalchemy import inspect
from app.db.session import Base
from app.models import *
revision='0001_initial'; down_revision=None; branch_labels=None; depends_on=None
def upgrade():
    bind=op.get_bind(); inspector=inspect(bind)
    for table in reversed(Base.metadata.sorted_tables):
        if table.name not in inspector.get_table_names(): table.create(bind)
def downgrade():
    bind=op.get_bind()
    for table in reversed(Base.metadata.sorted_tables):
        table.drop(bind)
