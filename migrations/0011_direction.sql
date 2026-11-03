-- 未来一小时方向：统计模型上涨概率、AI 判断与核对结果
-- （Worker 运行时也会自动补这些列；如果已自动补上，执行本文件会报 duplicate column，可跳过）
ALTER TABLE hourly_outlook ADD COLUMN p_up REAL;
ALTER TABLE hourly_outlook ADD COLUMN naive_dir INTEGER;
ALTER TABLE hourly_outlook ADD COLUMN ai_lean TEXT;
ALTER TABLE hourly_outlook ADD COLUMN ai_conf TEXT;
ALTER TABLE hourly_outlook ADD COLUMN dir_actual INTEGER;
ALTER TABLE hourly_outlook ADD COLUMN model_hit INTEGER;
ALTER TABLE hourly_outlook ADD COLUMN ai_hit INTEGER;
ALTER TABLE hourly_outlook ADD COLUMN naive_hit INTEGER;
