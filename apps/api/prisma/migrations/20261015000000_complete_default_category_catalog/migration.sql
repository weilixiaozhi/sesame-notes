BEGIN;

-- 迁移由 Prisma 部署记录执行一次；应用启动、登录和日常同步不执行目录补齐。
-- 与正常同步写入共用提交锁，新增分类和可被现有游标读取的事件一起提交。
SELECT pg_advisory_xact_lock(1936028513, 1);

CREATE TEMP TABLE default_category_repair_catalog (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL,
  level integer NOT NULL,
  sort_order integer NOT NULL,
  icon text,
  parent_id uuid,
  fingerprint_template text NOT NULL
) ON COMMIT DROP;

-- 目录及指纹字节在本次迁移中冻结；owner_id 占位符由当前账号的真实 UUID 替换。
INSERT INTO default_category_repair_catalog
  (id, name, kind, level, sort_order, icon, parent_id, fingerprint_template)
VALUES
  ('ffec6471-df8b-5bb3-8a05-93ef863ca958'::uuid, '餐饮', 'expense', 1, 0, 'utensils', NULL::uuid, '{"deleted_at":null,"icon":"utensils","id":"ffec6471-df8b-5bb3-8a05-93ef863ca958","kind":"expense","level":1,"name":"餐饮","owner_id":"__OWNER_ID__","parent_id":null,"sort_order":0,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('02d2cbc5-0298-5dea-ae85-f4616e0eafc2'::uuid, '早餐', 'expense', 2, 0, 'sandwich', 'ffec6471-df8b-5bb3-8a05-93ef863ca958'::uuid, '{"deleted_at":null,"icon":"sandwich","id":"02d2cbc5-0298-5dea-ae85-f4616e0eafc2","kind":"expense","level":2,"name":"早餐","owner_id":"__OWNER_ID__","parent_id":"ffec6471-df8b-5bb3-8a05-93ef863ca958","sort_order":0,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('8e557f0c-e127-5aac-9a9b-ef70559d6b19'::uuid, '午餐', 'expense', 2, 1, 'salad', 'ffec6471-df8b-5bb3-8a05-93ef863ca958'::uuid, '{"deleted_at":null,"icon":"salad","id":"8e557f0c-e127-5aac-9a9b-ef70559d6b19","kind":"expense","level":2,"name":"午餐","owner_id":"__OWNER_ID__","parent_id":"ffec6471-df8b-5bb3-8a05-93ef863ca958","sort_order":1,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('b2ace52b-5dad-5b9e-bf52-6148ee1980da'::uuid, '晚餐', 'expense', 2, 2, 'soup', 'ffec6471-df8b-5bb3-8a05-93ef863ca958'::uuid, '{"deleted_at":null,"icon":"soup","id":"b2ace52b-5dad-5b9e-bf52-6148ee1980da","kind":"expense","level":2,"name":"晚餐","owner_id":"__OWNER_ID__","parent_id":"ffec6471-df8b-5bb3-8a05-93ef863ca958","sort_order":2,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('5df946e0-5d7b-5cc0-aab9-ea20316f5f93'::uuid, '饮料', 'expense', 1, 1, 'milk', NULL::uuid, '{"deleted_at":null,"icon":"milk","id":"5df946e0-5d7b-5cc0-aab9-ea20316f5f93","kind":"expense","level":1,"name":"饮料","owner_id":"__OWNER_ID__","parent_id":null,"sort_order":1,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('43c5651e-c2b4-56ad-98d1-727d81cec8ac'::uuid, '奶茶', 'expense', 2, 0, 'cupSoda', '5df946e0-5d7b-5cc0-aab9-ea20316f5f93'::uuid, '{"deleted_at":null,"icon":"cupSoda","id":"43c5651e-c2b4-56ad-98d1-727d81cec8ac","kind":"expense","level":2,"name":"奶茶","owner_id":"__OWNER_ID__","parent_id":"5df946e0-5d7b-5cc0-aab9-ea20316f5f93","sort_order":0,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('fff1a2a4-b5d7-551b-aef1-a0482938eec4'::uuid, '咖啡', 'expense', 2, 1, 'coffee', '5df946e0-5d7b-5cc0-aab9-ea20316f5f93'::uuid, '{"deleted_at":null,"icon":"coffee","id":"fff1a2a4-b5d7-551b-aef1-a0482938eec4","kind":"expense","level":2,"name":"咖啡","owner_id":"__OWNER_ID__","parent_id":"5df946e0-5d7b-5cc0-aab9-ea20316f5f93","sort_order":1,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('a82f3dbc-18e4-5e00-8ff9-60ed35e6cd98'::uuid, '果汁', 'expense', 2, 2, 'glassWater', '5df946e0-5d7b-5cc0-aab9-ea20316f5f93'::uuid, '{"deleted_at":null,"icon":"glassWater","id":"a82f3dbc-18e4-5e00-8ff9-60ed35e6cd98","kind":"expense","level":2,"name":"果汁","owner_id":"__OWNER_ID__","parent_id":"5df946e0-5d7b-5cc0-aab9-ea20316f5f93","sort_order":2,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('8970a7b9-bf96-55e0-8fe6-3cd483598d65'::uuid, '汽水', 'expense', 2, 3, 'beer', '5df946e0-5d7b-5cc0-aab9-ea20316f5f93'::uuid, '{"deleted_at":null,"icon":"beer","id":"8970a7b9-bf96-55e0-8fe6-3cd483598d65","kind":"expense","level":2,"name":"汽水","owner_id":"__OWNER_ID__","parent_id":"5df946e0-5d7b-5cc0-aab9-ea20316f5f93","sort_order":3,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('6319dc3d-095a-50a2-ab12-fb099d2d0f31'::uuid, '矿泉水', 'expense', 2, 4, 'glassWater', '5df946e0-5d7b-5cc0-aab9-ea20316f5f93'::uuid, '{"deleted_at":null,"icon":"glassWater","id":"6319dc3d-095a-50a2-ab12-fb099d2d0f31","kind":"expense","level":2,"name":"矿泉水","owner_id":"__OWNER_ID__","parent_id":"5df946e0-5d7b-5cc0-aab9-ea20316f5f93","sort_order":4,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('ec29a35c-4562-5954-b5d2-60f4625d5f99'::uuid, '购物', 'expense', 1, 2, 'shoppingCart', NULL::uuid, '{"deleted_at":null,"icon":"shoppingCart","id":"ec29a35c-4562-5954-b5d2-60f4625d5f99","kind":"expense","level":1,"name":"购物","owner_id":"__OWNER_ID__","parent_id":null,"sort_order":2,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('96f9ca91-8ad3-5ec8-b40a-5a7ef7404d14'::uuid, '超市', 'expense', 2, 0, 'shoppingCart', 'ec29a35c-4562-5954-b5d2-60f4625d5f99'::uuid, '{"deleted_at":null,"icon":"shoppingCart","id":"96f9ca91-8ad3-5ec8-b40a-5a7ef7404d14","kind":"expense","level":2,"name":"超市","owner_id":"__OWNER_ID__","parent_id":"ec29a35c-4562-5954-b5d2-60f4625d5f99","sort_order":0,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('3846fffd-dc18-566e-86dc-b649016e7cec'::uuid, '服装', 'expense', 2, 1, 'shirt', 'ec29a35c-4562-5954-b5d2-60f4625d5f99'::uuid, '{"deleted_at":null,"icon":"shirt","id":"3846fffd-dc18-566e-86dc-b649016e7cec","kind":"expense","level":2,"name":"服装","owner_id":"__OWNER_ID__","parent_id":"ec29a35c-4562-5954-b5d2-60f4625d5f99","sort_order":1,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('15be13f4-9478-5f67-a9d5-883568ca5d46'::uuid, '鞋子', 'expense', 2, 2, 'footprints', 'ec29a35c-4562-5954-b5d2-60f4625d5f99'::uuid, '{"deleted_at":null,"icon":"footprints","id":"15be13f4-9478-5f67-a9d5-883568ca5d46","kind":"expense","level":2,"name":"鞋子","owner_id":"__OWNER_ID__","parent_id":"ec29a35c-4562-5954-b5d2-60f4625d5f99","sort_order":2,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('59f9abfd-7a38-5297-9b5c-cf4ea6ed538b'::uuid, '包包', 'expense', 2, 3, 'shoppingBag', 'ec29a35c-4562-5954-b5d2-60f4625d5f99'::uuid, '{"deleted_at":null,"icon":"shoppingBag","id":"59f9abfd-7a38-5297-9b5c-cf4ea6ed538b","kind":"expense","level":2,"name":"包包","owner_id":"__OWNER_ID__","parent_id":"ec29a35c-4562-5954-b5d2-60f4625d5f99","sort_order":3,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('512859af-c24d-5b60-a237-b7d974eaffec'::uuid, '交通', 'expense', 1, 3, 'bus', NULL::uuid, '{"deleted_at":null,"icon":"bus","id":"512859af-c24d-5b60-a237-b7d974eaffec","kind":"expense","level":1,"name":"交通","owner_id":"__OWNER_ID__","parent_id":null,"sort_order":3,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('21fdf6cc-8b18-57d3-81ff-e0e6d37b943a'::uuid, '交通卡充值', 'expense', 2, 0, 'walletCards', '512859af-c24d-5b60-a237-b7d974eaffec'::uuid, '{"deleted_at":null,"icon":"walletCards","id":"21fdf6cc-8b18-57d3-81ff-e0e6d37b943a","kind":"expense","level":2,"name":"交通卡充值","owner_id":"__OWNER_ID__","parent_id":"512859af-c24d-5b60-a237-b7d974eaffec","sort_order":0,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('4a5c221a-b79b-5acf-8450-fb2dbfc7b179'::uuid, '打车', 'expense', 2, 1, 'car', '512859af-c24d-5b60-a237-b7d974eaffec'::uuid, '{"deleted_at":null,"icon":"car","id":"4a5c221a-b79b-5acf-8450-fb2dbfc7b179","kind":"expense","level":2,"name":"打车","owner_id":"__OWNER_ID__","parent_id":"512859af-c24d-5b60-a237-b7d974eaffec","sort_order":1,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('296afb83-2957-5e69-b600-c07888dd81ee'::uuid, '停车费', 'expense', 2, 2, 'parkingCircle', '512859af-c24d-5b60-a237-b7d974eaffec'::uuid, '{"deleted_at":null,"icon":"parkingCircle","id":"296afb83-2957-5e69-b600-c07888dd81ee","kind":"expense","level":2,"name":"停车费","owner_id":"__OWNER_ID__","parent_id":"512859af-c24d-5b60-a237-b7d974eaffec","sort_order":2,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('b52bf0f1-4ee6-59b2-8f48-fe83418ef49f'::uuid, '加油', 'expense', 2, 3, 'fuel', '512859af-c24d-5b60-a237-b7d974eaffec'::uuid, '{"deleted_at":null,"icon":"fuel","id":"b52bf0f1-4ee6-59b2-8f48-fe83418ef49f","kind":"expense","level":2,"name":"加油","owner_id":"__OWNER_ID__","parent_id":"512859af-c24d-5b60-a237-b7d974eaffec","sort_order":3,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('0938ad4a-b8d5-5cf2-b3a8-763ce9d7f4c4'::uuid, '通讯', 'expense', 1, 4, 'phone', NULL::uuid, '{"deleted_at":null,"icon":"phone","id":"0938ad4a-b8d5-5cf2-b3a8-763ce9d7f4c4","kind":"expense","level":1,"name":"通讯","owner_id":"__OWNER_ID__","parent_id":null,"sort_order":4,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('a9ba1d1c-1307-5189-95d6-caa0dacd7d7b'::uuid, '水果', 'expense', 1, 5, 'apple', NULL::uuid, '{"deleted_at":null,"icon":"apple","id":"a9ba1d1c-1307-5189-95d6-caa0dacd7d7b","kind":"expense","level":1,"name":"水果","owner_id":"__OWNER_ID__","parent_id":null,"sort_order":5,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('92937ddc-e454-5e91-953a-0af335d9d469'::uuid, '零食', 'expense', 1, 6, 'lollipop', NULL::uuid, '{"deleted_at":null,"icon":"lollipop","id":"92937ddc-e454-5e91-953a-0af335d9d469","kind":"expense","level":1,"name":"零食","owner_id":"__OWNER_ID__","parent_id":null,"sort_order":6,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('a13cf817-17d8-5733-8af7-fa4ec1fa362b'::uuid, '运动', 'expense', 1, 7, 'dumbbell', NULL::uuid, '{"deleted_at":null,"icon":"dumbbell","id":"a13cf817-17d8-5733-8af7-fa4ec1fa362b","kind":"expense","level":1,"name":"运动","owner_id":"__OWNER_ID__","parent_id":null,"sort_order":7,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('05eef9fa-3c64-5bd7-9048-c0a97f0fcd41'::uuid, '宠物', 'expense', 1, 8, 'dog', NULL::uuid, '{"deleted_at":null,"icon":"dog","id":"05eef9fa-3c64-5bd7-9048-c0a97f0fcd41","kind":"expense","level":1,"name":"宠物","owner_id":"__OWNER_ID__","parent_id":null,"sort_order":8,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('6c5151de-257f-5e9f-abb7-338b78e1cef6'::uuid, '宠物食品', 'expense', 2, 0, 'bone', '05eef9fa-3c64-5bd7-9048-c0a97f0fcd41'::uuid, '{"deleted_at":null,"icon":"bone","id":"6c5151de-257f-5e9f-abb7-338b78e1cef6","kind":"expense","level":2,"name":"宠物食品","owner_id":"__OWNER_ID__","parent_id":"05eef9fa-3c64-5bd7-9048-c0a97f0fcd41","sort_order":0,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('fd9bf2d3-6317-52b8-94df-cfa2a066f93e'::uuid, '宠物用品', 'expense', 2, 1, 'boxes', '05eef9fa-3c64-5bd7-9048-c0a97f0fcd41'::uuid, '{"deleted_at":null,"icon":"boxes","id":"fd9bf2d3-6317-52b8-94df-cfa2a066f93e","kind":"expense","level":2,"name":"宠物用品","owner_id":"__OWNER_ID__","parent_id":"05eef9fa-3c64-5bd7-9048-c0a97f0fcd41","sort_order":1,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('23edba07-53f6-5fef-9a67-d9b894861794'::uuid, '宠物医疗', 'expense', 2, 2, 'stethoscope', '05eef9fa-3c64-5bd7-9048-c0a97f0fcd41'::uuid, '{"deleted_at":null,"icon":"stethoscope","id":"23edba07-53f6-5fef-9a67-d9b894861794","kind":"expense","level":2,"name":"宠物医疗","owner_id":"__OWNER_ID__","parent_id":"05eef9fa-3c64-5bd7-9048-c0a97f0fcd41","sort_order":2,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('585caae6-2c4d-5156-8a16-a2380f204fc6'::uuid, '宠物美容', 'expense', 2, 3, 'showerHead', '05eef9fa-3c64-5bd7-9048-c0a97f0fcd41'::uuid, '{"deleted_at":null,"icon":"showerHead","id":"585caae6-2c4d-5156-8a16-a2380f204fc6","kind":"expense","level":2,"name":"宠物美容","owner_id":"__OWNER_ID__","parent_id":"05eef9fa-3c64-5bd7-9048-c0a97f0fcd41","sort_order":3,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('da377fd1-ecfc-5913-8819-65b13a84925b'::uuid, '住房', 'expense', 1, 9, 'building2', NULL::uuid, '{"deleted_at":null,"icon":"building2","id":"da377fd1-ecfc-5913-8819-65b13a84925b","kind":"expense","level":1,"name":"住房","owner_id":"__OWNER_ID__","parent_id":null,"sort_order":9,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('400c5326-ba62-5dfd-bea3-c53a4ce4cb7b'::uuid, '水电煤', 'expense', 2, 0, 'zap', 'da377fd1-ecfc-5913-8819-65b13a84925b'::uuid, '{"deleted_at":null,"icon":"zap","id":"400c5326-ba62-5dfd-bea3-c53a4ce4cb7b","kind":"expense","level":2,"name":"水电煤","owner_id":"__OWNER_ID__","parent_id":"da377fd1-ecfc-5913-8819-65b13a84925b","sort_order":0,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('2fbbc1ac-b6ef-57cd-9031-1399706be5b9'::uuid, '物业费', 'expense', 2, 1, 'building', 'da377fd1-ecfc-5913-8819-65b13a84925b'::uuid, '{"deleted_at":null,"icon":"building","id":"2fbbc1ac-b6ef-57cd-9031-1399706be5b9","kind":"expense","level":2,"name":"物业费","owner_id":"__OWNER_ID__","parent_id":"da377fd1-ecfc-5913-8819-65b13a84925b","sort_order":1,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('67d2d94d-0726-5152-aa34-0ded96348f44'::uuid, '房租', 'expense', 2, 2, 'key', 'da377fd1-ecfc-5913-8819-65b13a84925b'::uuid, '{"deleted_at":null,"icon":"key","id":"67d2d94d-0726-5152-aa34-0ded96348f44","kind":"expense","level":2,"name":"房租","owner_id":"__OWNER_ID__","parent_id":"da377fd1-ecfc-5913-8819-65b13a84925b","sort_order":2,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('5c7207af-c09d-5a7d-9af2-d05a7f2a6cf1'::uuid, '房贷', 'expense', 2, 3, 'landmark', 'da377fd1-ecfc-5913-8819-65b13a84925b'::uuid, '{"deleted_at":null,"icon":"landmark","id":"5c7207af-c09d-5a7d-9af2-d05a7f2a6cf1","kind":"expense","level":2,"name":"房贷","owner_id":"__OWNER_ID__","parent_id":"da377fd1-ecfc-5913-8819-65b13a84925b","sort_order":3,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('9f511b4b-ae97-5ff9-9b31-d769692a90e3'::uuid, '宽带', 'expense', 2, 4, 'wifi', 'da377fd1-ecfc-5913-8819-65b13a84925b'::uuid, '{"deleted_at":null,"icon":"wifi","id":"9f511b4b-ae97-5ff9-9b31-d769692a90e3","kind":"expense","level":2,"name":"宽带","owner_id":"__OWNER_ID__","parent_id":"da377fd1-ecfc-5913-8819-65b13a84925b","sort_order":4,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('1249a4d4-43d7-50a7-b5e1-f701e9df68b1'::uuid, '转账', 'expense', 1, 10, 'handCoins', NULL::uuid, '{"deleted_at":null,"icon":"handCoins","id":"1249a4d4-43d7-50a7-b5e1-f701e9df68b1","kind":"expense","level":1,"name":"转账","owner_id":"__OWNER_ID__","parent_id":null,"sort_order":10,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('9a2c4726-13fc-5cfe-9f86-2e63d2803bad'::uuid, '生活费', 'expense', 2, 0, 'heartHandshake', '1249a4d4-43d7-50a7-b5e1-f701e9df68b1'::uuid, '{"deleted_at":null,"icon":"heartHandshake","id":"9a2c4726-13fc-5cfe-9f86-2e63d2803bad","kind":"expense","level":2,"name":"生活费","owner_id":"__OWNER_ID__","parent_id":"1249a4d4-43d7-50a7-b5e1-f701e9df68b1","sort_order":0,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('2d171f77-4caa-58cf-a887-aeab8172b5ed'::uuid, '家庭', 'expense', 2, 1, 'users', '1249a4d4-43d7-50a7-b5e1-f701e9df68b1'::uuid, '{"deleted_at":null,"icon":"users","id":"2d171f77-4caa-58cf-a887-aeab8172b5ed","kind":"expense","level":2,"name":"家庭","owner_id":"__OWNER_ID__","parent_id":"1249a4d4-43d7-50a7-b5e1-f701e9df68b1","sort_order":1,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('59f0772c-cf83-5de5-9802-c0c0ab88ed38'::uuid, '父母', 'expense', 2, 2, 'users2', '1249a4d4-43d7-50a7-b5e1-f701e9df68b1'::uuid, '{"deleted_at":null,"icon":"users2","id":"59f0772c-cf83-5de5-9802-c0c0ab88ed38","kind":"expense","level":2,"name":"父母","owner_id":"__OWNER_ID__","parent_id":"1249a4d4-43d7-50a7-b5e1-f701e9df68b1","sort_order":2,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('4741981e-e87c-547e-8b9a-eff97c889fd1'::uuid, '恋人', 'expense', 2, 3, 'heart', '1249a4d4-43d7-50a7-b5e1-f701e9df68b1'::uuid, '{"deleted_at":null,"icon":"heart","id":"4741981e-e87c-547e-8b9a-eff97c889fd1","kind":"expense","level":2,"name":"恋人","owner_id":"__OWNER_ID__","parent_id":"1249a4d4-43d7-50a7-b5e1-f701e9df68b1","sort_order":3,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('25fb86ba-cd2f-5507-a0e1-d8cec501fd00'::uuid, '借钱', 'expense', 2, 4, 'coins', '1249a4d4-43d7-50a7-b5e1-f701e9df68b1'::uuid, '{"deleted_at":null,"icon":"coins","id":"25fb86ba-cd2f-5507-a0e1-d8cec501fd00","kind":"expense","level":2,"name":"借钱","owner_id":"__OWNER_ID__","parent_id":"1249a4d4-43d7-50a7-b5e1-f701e9df68b1","sort_order":4,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('961e3602-ad43-5c82-af2f-4202def6098c'::uuid, '订阅服务', 'expense', 1, 11, 'calendarClock', NULL::uuid, '{"deleted_at":null,"icon":"calendarClock","id":"961e3602-ad43-5c82-af2f-4202def6098c","kind":"expense","level":1,"name":"订阅服务","owner_id":"__OWNER_ID__","parent_id":null,"sort_order":11,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('057658c8-29f9-57f0-a989-67763c551e92'::uuid, '视频会员', 'expense', 2, 0, 'playCircle', '961e3602-ad43-5c82-af2f-4202def6098c'::uuid, '{"deleted_at":null,"icon":"playCircle","id":"057658c8-29f9-57f0-a989-67763c551e92","kind":"expense","level":2,"name":"视频会员","owner_id":"__OWNER_ID__","parent_id":"961e3602-ad43-5c82-af2f-4202def6098c","sort_order":0,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('61e2fe39-484a-517c-9378-2818dfa0a5fb'::uuid, '音乐会员', 'expense', 2, 1, 'music', '961e3602-ad43-5c82-af2f-4202def6098c'::uuid, '{"deleted_at":null,"icon":"music","id":"61e2fe39-484a-517c-9378-2818dfa0a5fb","kind":"expense","level":2,"name":"音乐会员","owner_id":"__OWNER_ID__","parent_id":"961e3602-ad43-5c82-af2f-4202def6098c","sort_order":1,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('e0315338-f078-5f93-9227-373acba72456'::uuid, '娱乐', 'expense', 1, 12, 'partyPopper', NULL::uuid, '{"deleted_at":null,"icon":"partyPopper","id":"e0315338-f078-5f93-9227-373acba72456","kind":"expense","level":1,"name":"娱乐","owner_id":"__OWNER_ID__","parent_id":null,"sort_order":12,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('9ce2dc2a-972e-5441-b2f3-bc7e31c72d48'::uuid, '电影', 'expense', 2, 0, 'clapperboard', 'e0315338-f078-5f93-9227-373acba72456'::uuid, '{"deleted_at":null,"icon":"clapperboard","id":"9ce2dc2a-972e-5441-b2f3-bc7e31c72d48","kind":"expense","level":2,"name":"电影","owner_id":"__OWNER_ID__","parent_id":"e0315338-f078-5f93-9227-373acba72456","sort_order":0,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('0c2855e2-6c95-5bc4-9cab-1e63e6154c4a'::uuid, 'KTV', 'expense', 2, 1, 'mic', 'e0315338-f078-5f93-9227-373acba72456'::uuid, '{"deleted_at":null,"icon":"mic","id":"0c2855e2-6c95-5bc4-9cab-1e63e6154c4a","kind":"expense","level":2,"name":"KTV","owner_id":"__OWNER_ID__","parent_id":"e0315338-f078-5f93-9227-373acba72456","sort_order":1,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('a3f3062c-51cf-5376-9ff3-fba3d9ed3db0'::uuid, '游乐场', 'expense', 2, 2, 'ferrisWheel', 'e0315338-f078-5f93-9227-373acba72456'::uuid, '{"deleted_at":null,"icon":"ferrisWheel","id":"a3f3062c-51cf-5376-9ff3-fba3d9ed3db0","kind":"expense","level":2,"name":"游乐场","owner_id":"__OWNER_ID__","parent_id":"e0315338-f078-5f93-9227-373acba72456","sort_order":2,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('591c233c-e6e2-5a61-92d6-5676aa2c8168'::uuid, '教育', 'expense', 1, 13, 'graduationCap', NULL::uuid, '{"deleted_at":null,"icon":"graduationCap","id":"591c233c-e6e2-5a61-92d6-5676aa2c8168","kind":"expense","level":1,"name":"教育","owner_id":"__OWNER_ID__","parent_id":null,"sort_order":13,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('04d0df3a-6839-5303-a969-717eb8337dba'::uuid, '书籍', 'expense', 2, 0, 'bookOpen', '591c233c-e6e2-5a61-92d6-5676aa2c8168'::uuid, '{"deleted_at":null,"icon":"bookOpen","id":"04d0df3a-6839-5303-a969-717eb8337dba","kind":"expense","level":2,"name":"书籍","owner_id":"__OWNER_ID__","parent_id":"591c233c-e6e2-5a61-92d6-5676aa2c8168","sort_order":0,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('826307fd-4c88-5563-a004-913831ec0568'::uuid, '学习', 'expense', 2, 1, 'library', '591c233c-e6e2-5a61-92d6-5676aa2c8168'::uuid, '{"deleted_at":null,"icon":"library","id":"826307fd-4c88-5563-a004-913831ec0568","kind":"expense","level":2,"name":"学习","owner_id":"__OWNER_ID__","parent_id":"591c233c-e6e2-5a61-92d6-5676aa2c8168","sort_order":1,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('20724e51-e4e5-52c2-ac07-12308bdd93a0'::uuid, '送礼', 'expense', 1, 14, 'gift', NULL::uuid, '{"deleted_at":null,"icon":"gift","id":"20724e51-e4e5-52c2-ac07-12308bdd93a0","kind":"expense","level":1,"name":"送礼","owner_id":"__OWNER_ID__","parent_id":null,"sort_order":14,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('4338eb66-6a81-5a68-8d30-09d0592b07d5'::uuid, '游戏', 'expense', 1, 15, 'gamepad2', NULL::uuid, '{"deleted_at":null,"icon":"gamepad2","id":"4338eb66-6a81-5a68-8d30-09d0592b07d5","kind":"expense","level":1,"name":"游戏","owner_id":"__OWNER_ID__","parent_id":null,"sort_order":15,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('6c3ee0f3-0d88-50df-8707-4c81b7be41aa'::uuid, '美容', 'expense', 1, 16, 'sparkles', NULL::uuid, '{"deleted_at":null,"icon":"sparkles","id":"6c3ee0f3-0d88-50df-8707-4c81b7be41aa","kind":"expense","level":1,"name":"美容","owner_id":"__OWNER_ID__","parent_id":null,"sort_order":16,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('002b36a1-98e9-5550-b451-734d3b96d65e'::uuid, '护肤品', 'expense', 2, 0, 'smile', '6c3ee0f3-0d88-50df-8707-4c81b7be41aa'::uuid, '{"deleted_at":null,"icon":"smile","id":"002b36a1-98e9-5550-b451-734d3b96d65e","kind":"expense","level":2,"name":"护肤品","owner_id":"__OWNER_ID__","parent_id":"6c3ee0f3-0d88-50df-8707-4c81b7be41aa","sort_order":0,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('22fd9bbe-dc72-5842-b469-8c1b066b7e2e'::uuid, '化妆品', 'expense', 2, 1, 'palette', '6c3ee0f3-0d88-50df-8707-4c81b7be41aa'::uuid, '{"deleted_at":null,"icon":"palette","id":"22fd9bbe-dc72-5842-b469-8c1b066b7e2e","kind":"expense","level":2,"name":"化妆品","owner_id":"__OWNER_ID__","parent_id":"6c3ee0f3-0d88-50df-8707-4c81b7be41aa","sort_order":1,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('7730e10e-0c3e-59e1-959a-27e615bfbc16'::uuid, '剪发', 'expense', 2, 2, 'scissors', '6c3ee0f3-0d88-50df-8707-4c81b7be41aa'::uuid, '{"deleted_at":null,"icon":"scissors","id":"7730e10e-0c3e-59e1-959a-27e615bfbc16","kind":"expense","level":2,"name":"剪发","owner_id":"__OWNER_ID__","parent_id":"6c3ee0f3-0d88-50df-8707-4c81b7be41aa","sort_order":2,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('ddd6e5c5-e860-5aa1-811e-4bc451763e6d'::uuid, '美甲', 'expense', 2, 3, 'hand', '6c3ee0f3-0d88-50df-8707-4c81b7be41aa'::uuid, '{"deleted_at":null,"icon":"hand","id":"ddd6e5c5-e860-5aa1-811e-4bc451763e6d","kind":"expense","level":2,"name":"美甲","owner_id":"__OWNER_ID__","parent_id":"6c3ee0f3-0d88-50df-8707-4c81b7be41aa","sort_order":3,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('1aaf1de7-d76b-5d4a-8e65-7ea7db0f39b9'::uuid, '医疗', 'expense', 1, 17, 'cross', NULL::uuid, '{"deleted_at":null,"icon":"cross","id":"1aaf1de7-d76b-5d4a-8e65-7ea7db0f39b9","kind":"expense","level":1,"name":"医疗","owner_id":"__OWNER_ID__","parent_id":null,"sort_order":17,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('4e7ce64f-38e0-5fbc-9478-ee19190a9e4a'::uuid, '数码', 'expense', 1, 18, 'smartphone', NULL::uuid, '{"deleted_at":null,"icon":"smartphone","id":"4e7ce64f-38e0-5fbc-9478-ee19190a9e4a","kind":"expense","level":1,"name":"数码","owner_id":"__OWNER_ID__","parent_id":null,"sort_order":18,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}'),
  ('8899479b-cc3a-58be-af71-c78b1041c480'::uuid, '其他', 'expense', 1, 19, 'package', NULL::uuid, '{"deleted_at":null,"icon":"package","id":"8899479b-cc3a-58be-af71-c78b1041c480","kind":"expense","level":1,"name":"其他","owner_id":"__OWNER_ID__","parent_id":null,"sort_order":19,"updated_at":"1970-01-01T00:00:00.000Z","updated_by_device_id":null}');

DO $repair$
DECLARE
  category_level integer;
BEGIN
  -- 两次批量写入先父后子，子项只能连接当前账号中仍有效的一级父分类。
  FOR category_level IN 1..2 LOOP
    WITH inserted AS (
      INSERT INTO categories
        (id, owner_id, name, kind, level, sort_order, icon, parent_id, updated_at, updated_by_device_id)
      SELECT seed.id, account.id, seed.name, seed.kind, seed.level, seed.sort_order,
             seed.icon, seed.parent_id, TIMESTAMPTZ '1970-01-01 00:00:00+00', NULL
      FROM users account CROSS JOIN default_category_repair_catalog seed
      WHERE seed.level = category_level
        -- 同 UUID 的活跃行、墓碑、改名和改层级都代表既有用户内容。
        AND NOT EXISTS (SELECT 1 FROM categories current
                        WHERE current.owner_id = account.id AND current.id = seed.id)
        -- 同父同名自定义项保持独立身份；已删除的同名项也不以默认名重新出现。
        AND NOT EXISTS (
          SELECT 1 FROM categories current
          WHERE current.owner_id = account.id AND current.kind = seed.kind
            AND current.level = seed.level AND current.parent_id IS NOT DISTINCT FROM seed.parent_id
            AND btrim(current.name, U&'\0009\000A\000B\000C\000D\0020\0085\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') = seed.name
        )
        -- 保留仍可核对的删除记录及未确认意图，不替用户重新选择分类。
        AND NOT EXISTS (SELECT 1 FROM sync_changes history
                        WHERE history.user_id = account.id AND history.entity_type = 'category'
                          AND history.entity_id = seed.id AND history.action = 'delete')
        AND NOT EXISTS (SELECT 1 FROM category_conflicts pending
                        WHERE pending.owner_id = account.id AND pending.status = 'pending'
                          AND (pending.category_id = seed.id OR pending.category_id = seed.parent_id))
        AND (seed.level = 1 OR EXISTS (
          SELECT 1 FROM categories parent
          WHERE parent.owner_id = account.id AND parent.id = seed.parent_id
            AND parent.deleted_at IS NULL AND parent.level = 1
            AND parent.parent_id IS NULL AND parent.kind = seed.kind
        ))
      ON CONFLICT (id, owner_id) DO NOTHING
      RETURNING *
    )
    INSERT INTO sync_changes
      (user_id, ledger_id, scope, entity_type, entity_id, action, mutation_id, payload, updated_at, device_id)
    SELECT inserted.owner_id, NULL, 'user', 'category', inserted.id, 'upsert', gen_random_uuid(),
           json_build_object(
             'id', inserted.id, 'owner_id', inserted.owner_id, 'name', inserted.name,
             'kind', inserted.kind, 'level', inserted.level, 'sort_order', inserted.sort_order,
             'icon', inserted.icon, 'parent_id', inserted.parent_id,
             'updated_at', '1970-01-01T00:00:00.000Z', 'deleted_at', NULL,
             -- 与 categoryVersionToken 的无空格、按键排序 JSON 字节保持一致。
             'version_token', encode(sha256(convert_to(
               replace(seed.fingerprint_template, '__OWNER_ID__', inserted.owner_id::text), 'UTF8'
             )), 'hex')
           ), inserted.updated_at,
           -- 明确的迁移事件来源，不创建登录设备，也不借用用户的真实设备身份。
           '00000000-0000-4000-8000-000000000061'::uuid
    FROM inserted JOIN default_category_repair_catalog seed ON seed.id = inserted.id;
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION USING MESSAGE = '默认分类目录修复失败，事务未提交', DETAIL = SQLERRM;
END
$repair$;

COMMIT;
