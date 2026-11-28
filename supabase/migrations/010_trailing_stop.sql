-- Add partial take profit tracking to positions
ALTER TABLE positions ADD COLUMN IF NOT EXISTS partial_tp_done boolean DEFAULT false;
